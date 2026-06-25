use std::{
    collections::HashSet,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use color_eyre::eyre::{WrapErr, eyre};
use sqlx::SqlitePool;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{config::ScheduleConfig, prompt};

mod gate;

#[derive(Clone, Debug, PartialEq)]
pub struct Schedule {
    pub id: String,
    pub platform: String,
    pub scope: String,
    pub name: String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub mode: Mode,
    pub origin: String,
    pub target: String,
    pub trigger: Trigger,
    pub script: Option<String>,
    pub prompt: Option<String>,
    pub next_run_at: DateTime<Utc>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub consecutive_failures: i64,
    pub state: State,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Continue,
    Fresh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Active,
    Disabled,
    Triggered,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Trigger {
    Oneshot { at: DateTime<Utc> },
    Cron { expr: String, tz: chrono_tz::Tz },
    Interval { every: Duration },
}

#[derive(Clone, Debug, PartialEq)]
pub struct NewSchedule {
    pub platform: String,
    pub scope: String,
    pub name: String,
    pub created_by: String,
    pub mode: Mode,
    pub origin: String,
    pub target: String,
    pub trigger: Trigger,
    pub script: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FireOutcome {
    Delivered,
    TargetGone,
    Transient,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HomeNotice {
    ScriptFailed { reason: String, stderr_tail: String },
    Missed { due: DateTime<Utc> },
    Disabled(DisableReason),
}

#[derive(Clone, Debug, PartialEq)]
pub enum DisableReason {
    TargetUnresolvable,
    OriginUnreachable,
    TargetUnreachable,
    ConsecutiveFailures(i64),
}

pub trait ScheduleHost: Send + Sync {
    fn resolve_cwd(&self, sched: &Schedule) -> impl Future<Output = color_eyre::Result<Option<PathBuf>>> + Send;
    fn fire(&self, sched: &Schedule, wrapped_prompt: &str) -> impl Future<Output = FireOutcome> + Send;
    fn post_raw(&self, sched: &Schedule, text: &str) -> impl Future<Output = FireOutcome> + Send;
    fn notify_home(&self, sched: &Schedule, notice: &HomeNotice) -> impl Future<Output = ()> + Send;
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Continue => "continue",
            Mode::Fresh => "fresh",
        }
    }

    fn parse(value: &str) -> Option<Mode> {
        match value {
            "continue" => Some(Mode::Continue),
            "fresh" => Some(Mode::Fresh),
            _ => None,
        }
    }
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            State::Active => "active",
            State::Disabled => "disabled",
            State::Triggered => "triggered",
        }
    }

    fn parse(value: &str) -> Option<State> {
        match value {
            "active" => Some(State::Active),
            "disabled" => Some(State::Disabled),
            "triggered" => Some(State::Triggered),
            _ => None,
        }
    }
}

impl Trigger {
    pub fn describe(&self) -> String {
        match self {
            Trigger::Oneshot { at } => format!("oneshot at {}", store_ts(*at)),
            Trigger::Cron { expr, tz } => format!("cron \"{expr}\" ({tz})"),
            Trigger::Interval { every } => format!("every {}s", every.as_secs()),
        }
    }
}

pub fn next_after(trigger: &Trigger, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    match trigger {
        Trigger::Oneshot { at } => Some(*at),
        Trigger::Cron { expr, tz } => {
            let schedule = parse_cron(expr).ok()?;
            schedule
                .after(&after.with_timezone(tz))
                .next()
                .map(|dt| dt.with_timezone(&Utc))
        }
        Trigger::Interval { every } => after.checked_add_signed(to_delta(*every)),
    }
}

pub fn validate(new: &NewSchedule) -> color_eyre::Result<()> {
    if new.script.is_none() && new.prompt.is_none() {
        return Err(eyre!("schedule must define a script, a prompt, or both"));
    }
    if new.name.trim().is_empty() {
        return Err(eyre!("schedule name must not be empty"));
    }
    match &new.trigger {
        Trigger::Oneshot { at } => {
            if *at <= now() {
                return Err(eyre!("scheduled time is in the past"));
            }
        }
        Trigger::Cron { expr, .. } => {
            parse_cron(expr)?;
        }
        Trigger::Interval { every } => {
            if *every < Duration::from_secs(60) {
                return Err(eyre!("interval must be at least 60 seconds"));
            }
        }
    }
    Ok(())
}

const SELECT_LIST: &str = "SELECT id, platform, scope, name, created_by, created_at, mode, origin, \
     target, trigger_kind, cron_expr, tz, interval_secs, script, prompt, next_run_at, last_run_at, \
     consecutive_failures, state FROM schedules WHERE platform = ? AND scope = ? ORDER BY created_at";

const SELECT_BY_ID: &str = "SELECT id, platform, scope, name, created_by, created_at, mode, origin, \
     target, trigger_kind, cron_expr, tz, interval_secs, script, prompt, next_run_at, last_run_at, \
     consecutive_failures, state FROM schedules WHERE id = ?";

const SELECT_DUE: &str = "SELECT id, platform, scope, name, created_by, created_at, mode, origin, \
     target, trigger_kind, cron_expr, tz, interval_secs, script, prompt, next_run_at, last_run_at, \
     consecutive_failures, state FROM schedules WHERE state = 'active' AND next_run_at <= ? \
     ORDER BY next_run_at";

#[derive(sqlx::FromRow)]
struct ScheduleRow {
    id: String,
    platform: String,
    scope: String,
    name: String,
    created_by: String,
    created_at: String,
    mode: String,
    origin: String,
    target: String,
    trigger_kind: String,
    cron_expr: Option<String>,
    tz: Option<String>,
    interval_secs: Option<i64>,
    script: Option<String>,
    prompt: Option<String>,
    next_run_at: String,
    last_run_at: Option<String>,
    consecutive_failures: i64,
    state: String,
}

pub async fn create(db: &SqlitePool, new: NewSchedule) -> color_eyre::Result<Schedule> {
    validate(&new)?;
    let created_at = now();
    let next_run_at =
        trunc_secs(next_after(&new.trigger, created_at).ok_or_else(|| eyre!("trigger has no upcoming occurrence"))?);
    let id = ulid::Ulid::new().to_string();
    let (trigger_kind, cron_expr, tz, interval_secs) = trigger_columns(&new.trigger);
    sqlx::query(
        "INSERT INTO schedules (\
         id, platform, scope, name, created_by, created_at, mode, origin, target, \
         trigger_kind, cron_expr, tz, interval_secs, script, prompt, next_run_at, \
         last_run_at, consecutive_failures, state) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'active')",
    )
    .bind(&id)
    .bind(&new.platform)
    .bind(&new.scope)
    .bind(&new.name)
    .bind(&new.created_by)
    .bind(store_ts(created_at))
    .bind(new.mode.as_str())
    .bind(&new.origin)
    .bind(&new.target)
    .bind(trigger_kind)
    .bind(&cron_expr)
    .bind(&tz)
    .bind(interval_secs)
    .bind(&new.script)
    .bind(&new.prompt)
    .bind(store_ts(next_run_at))
    .execute(db)
    .await
    .wrap_err("inserting schedule")?;
    let trigger = match new.trigger {
        Trigger::Oneshot { .. } => Trigger::Oneshot { at: next_run_at },
        other => other,
    };
    Ok(Schedule {
        id,
        platform: new.platform,
        scope: new.scope,
        name: new.name,
        created_by: new.created_by,
        created_at,
        mode: new.mode,
        origin: new.origin,
        target: new.target,
        trigger,
        script: new.script,
        prompt: new.prompt,
        next_run_at,
        last_run_at: None,
        consecutive_failures: 0,
        state: State::Active,
    })
}

pub async fn list(db: &SqlitePool, platform: &str, scope: &str) -> color_eyre::Result<Vec<Schedule>> {
    let rows: Vec<ScheduleRow> = sqlx::query_as(SELECT_LIST)
        .bind(platform)
        .bind(scope)
        .fetch_all(db)
        .await
        .wrap_err("listing schedules")?;
    Ok(rows.into_iter().filter_map(keep_parsed).collect())
}

pub async fn get(db: &SqlitePool, id: &str) -> color_eyre::Result<Option<Schedule>> {
    let row: Option<ScheduleRow> = sqlx::query_as(SELECT_BY_ID)
        .bind(id)
        .fetch_optional(db)
        .await
        .wrap_err("loading schedule")?;
    Ok(row.and_then(parse_row))
}

pub async fn remove(db: &SqlitePool, id: &str) -> color_eyre::Result<bool> {
    let result = sqlx::query("DELETE FROM schedules WHERE id = ?")
        .bind(id)
        .execute(db)
        .await
        .wrap_err("removing schedule")?;
    Ok(result.rows_affected() > 0)
}

pub async fn set_state(db: &SqlitePool, id: &str, state: State) -> color_eyre::Result<bool> {
    let result = sqlx::query("UPDATE schedules SET state = ? WHERE id = ?")
        .bind(state.as_str())
        .bind(id)
        .execute(db)
        .await
        .wrap_err("updating schedule state")?;
    Ok(result.rows_affected() > 0)
}

pub async fn due(db: &SqlitePool, now: DateTime<Utc>) -> color_eyre::Result<Vec<Schedule>> {
    let rows: Vec<ScheduleRow> = sqlx::query_as(SELECT_DUE)
        .bind(store_ts(now))
        .fetch_all(db)
        .await
        .wrap_err("loading due schedules")?;
    Ok(rows.into_iter().filter_map(keep_parsed).collect())
}

pub async fn nearest_next(db: &SqlitePool) -> color_eyre::Result<Option<DateTime<Utc>>> {
    let value: Option<String> = sqlx::query_scalar("SELECT MIN(next_run_at) FROM schedules WHERE state = 'active'")
        .fetch_one(db)
        .await
        .wrap_err("computing nearest schedule")?;
    Ok(value.and_then(|raw| parse_ts(&raw)))
}

async fn nearest_active(db: &SqlitePool, exclude: &HashSet<String>) -> color_eyre::Result<Option<DateTime<Utc>>> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT id, next_run_at FROM schedules WHERE state = 'active'")
        .fetch_all(db)
        .await
        .wrap_err("computing nearest active schedule")?;
    Ok(rows
        .into_iter()
        .filter(|(id, _)| !exclude.contains(id))
        .filter_map(|(_, ts)| parse_ts(&ts))
        .min())
}

pub async fn advance_recurring(
    db: &SqlitePool,
    id: &str,
    last_run_at: DateTime<Utc>,
    next_run_at: DateTime<Utc>,
) -> color_eyre::Result<()> {
    sqlx::query("UPDATE schedules SET last_run_at = ?, next_run_at = ?, consecutive_failures = 0 WHERE id = ?")
        .bind(store_ts(last_run_at))
        .bind(store_ts(next_run_at))
        .bind(id)
        .execute(db)
        .await
        .wrap_err("advancing recurring schedule")?;
    Ok(())
}

pub async fn finish_oneshot(db: &SqlitePool, id: &str, last_run_at: Option<DateTime<Utc>>) -> color_eyre::Result<()> {
    sqlx::query("UPDATE schedules SET state = 'triggered', last_run_at = COALESCE(?, last_run_at) WHERE id = ?")
        .bind(last_run_at.map(store_ts))
        .bind(id)
        .execute(db)
        .await
        .wrap_err("finishing oneshot schedule")?;
    Ok(())
}

pub async fn record_failure(db: &SqlitePool, id: &str) -> color_eyre::Result<i64> {
    let value: Option<i64> = sqlx::query_scalar(
        "UPDATE schedules SET consecutive_failures = consecutive_failures + 1 WHERE id = ? \
         RETURNING consecutive_failures",
    )
    .bind(id)
    .fetch_optional(db)
    .await
    .wrap_err("recording schedule failure")?;
    Ok(value.unwrap_or(0))
}

pub async fn disable(db: &SqlitePool, id: &str) -> color_eyre::Result<()> {
    sqlx::query("UPDATE schedules SET state = 'disabled' WHERE id = ?")
        .bind(id)
        .execute(db)
        .await
        .wrap_err("disabling schedule")?;
    Ok(())
}

async fn set_next_run(
    db: &SqlitePool,
    id: &str,
    last_run_at: DateTime<Utc>,
    next_run_at: DateTime<Utc>,
) -> color_eyre::Result<()> {
    sqlx::query("UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?")
        .bind(store_ts(last_run_at))
        .bind(store_ts(next_run_at))
        .bind(id)
        .execute(db)
        .await
        .wrap_err("rescheduling schedule after failure")?;
    Ok(())
}

const MAX_CONSECUTIVE_FAILURES: i64 = 3;
const MIN_IDLE: Duration = Duration::from_secs(1);
const TRANSIENT_RETRY_BACKOFF: Duration = Duration::from_secs(300);

pub async fn run<H: ScheduleHost + 'static>(db: &SqlitePool, host: H, cfg: ScheduleConfig, cancel: CancellationToken) {
    let db = db.clone();
    let host = Arc::new(host);
    let tracker = TaskTracker::new();
    let in_flight: Arc<parking_lot::Mutex<HashSet<String>>> = Arc::new(parking_lot::Mutex::new(HashSet::new()));

    loop {
        if cancel.is_cancelled() {
            break;
        }
        let moment = now();
        match due(&db, moment).await {
            Ok(rows) => {
                for sched in rows {
                    if !in_flight.lock().insert(sched.id.clone()) {
                        continue;
                    }
                    let db = db.clone();
                    let host = Arc::clone(&host);
                    let in_flight = Arc::clone(&in_flight);
                    let id = sched.id.clone();
                    tracker.spawn(async move {
                        if let Err(e) = fire_one(&db, host.as_ref(), &cfg, &sched, moment).await {
                            tracing::warn!(schedule_id = %sched.id, error = ?e, "scheduled fire failed");
                        }
                        in_flight.lock().remove(&id);
                    });
                }
            }
            Err(e) => tracing::warn!(error = ?e, "scheduler due query failed"),
        }

        let after = now();
        let snapshot = in_flight.lock().clone();
        let target = sleep_target(&db, after, cfg.cap, &snapshot).await;
        let wait = (target - after).to_std().unwrap_or(Duration::ZERO);
        let wait = if wait.is_zero() { MIN_IDLE } else { wait };
        tokio::select! {
            () = cancel.cancelled() => break,
            () = tokio::time::sleep(wait) => {}
        }
    }

    tracker.close();
    tracker.wait().await;
}

pub async fn fire_one<H: ScheduleHost>(
    db: &SqlitePool,
    host: &H,
    cfg: &ScheduleConfig,
    sched: &Schedule,
    now: DateTime<Utc>,
) -> color_eyre::Result<()> {
    match missed_gate(sched, now, cfg.grace) {
        Disposition::MissedOneshot => {
            host.notify_home(sched, &HomeNotice::Missed { due: sched.next_run_at })
                .await;
            finish_oneshot(db, &sched.id, None).await?;
            return Ok(());
        }
        Disposition::SkipStale => {
            advance_or_finish(db, sched, now).await?;
            return Ok(());
        }
        Disposition::Fire => {}
    }

    let cwd = match host.resolve_cwd(sched).await {
        Ok(Some(cwd)) => cwd,
        Ok(None) => {
            disable(db, &sched.id).await?;
            host.notify_home(sched, &HomeNotice::Disabled(DisableReason::TargetUnresolvable))
                .await;
            return Ok(());
        }
        Err(e) => {
            tracing::warn!(schedule_id = %sched.id, error = ?e, "resolving scheduled cwd failed");
            return record_transient(db, host, sched, now).await;
        }
    };

    match gate::run_script(sched.script.as_deref(), &cwd, cfg.script_timeout).await {
        gate::Gate::Skip => advance_or_finish(db, sched, now).await?,
        gate::Gate::Failure { reason, stderr_tail } => {
            host.notify_home(sched, &HomeNotice::ScriptFailed { reason, stderr_tail })
                .await;
            record_transient(db, host, sched, now).await?;
        }
        gate::Gate::Proceed { context } => proceed(db, host, sched, now, context).await?,
    }
    Ok(())
}

async fn proceed<H: ScheduleHost>(
    db: &SqlitePool,
    host: &H,
    sched: &Schedule,
    now: DateTime<Utc>,
    context: Option<String>,
) -> color_eyre::Result<()> {
    if let Some(prompt_body) = &sched.prompt {
        let wrapped = prompt::wrap_scheduled_job(
            &sched.name,
            &sched.trigger.describe(),
            &store_ts(now),
            prompt_body,
            context.as_deref(),
        );
        match host.fire(sched, &wrapped).await {
            FireOutcome::Delivered => advance_or_finish(db, sched, now).await?,
            FireOutcome::TargetGone => {
                disable(db, &sched.id).await?;
                host.notify_home(sched, &HomeNotice::Disabled(DisableReason::OriginUnreachable))
                    .await;
            }
            FireOutcome::Transient => record_transient(db, host, sched, now).await?,
        }
    } else if let Some(text) = context.as_deref().filter(|c| !c.trim().is_empty()) {
        match host.post_raw(sched, text).await {
            FireOutcome::Delivered => advance_or_finish(db, sched, now).await?,
            FireOutcome::TargetGone => {
                disable(db, &sched.id).await?;
                host.notify_home(sched, &HomeNotice::Disabled(DisableReason::TargetUnreachable))
                    .await;
            }
            FireOutcome::Transient => record_transient(db, host, sched, now).await?,
        }
    } else {
        advance_or_finish(db, sched, now).await?;
    }
    Ok(())
}

async fn advance_or_finish(db: &SqlitePool, sched: &Schedule, now: DateTime<Utc>) -> color_eyre::Result<()> {
    match &sched.trigger {
        Trigger::Oneshot { .. } => finish_oneshot(db, &sched.id, Some(now)).await,
        trigger => match next_after(trigger, now) {
            Some(next) => advance_recurring(db, &sched.id, now, trunc_secs(next)).await,
            None => disable(db, &sched.id).await,
        },
    }
}

async fn advance_after_failure(db: &SqlitePool, sched: &Schedule, now: DateTime<Utc>) -> color_eyre::Result<()> {
    match &sched.trigger {
        Trigger::Oneshot { .. } => finish_oneshot(db, &sched.id, Some(now)).await,
        trigger => match next_after(trigger, now) {
            Some(next) => set_next_run(db, &sched.id, now, trunc_secs(next)).await,
            None => disable(db, &sched.id).await,
        },
    }
}

async fn record_transient<H: ScheduleHost>(
    db: &SqlitePool,
    host: &H,
    sched: &Schedule,
    now: DateTime<Utc>,
) -> color_eyre::Result<()> {
    let failures = record_failure(db, &sched.id).await?;
    if failures >= MAX_CONSECUTIVE_FAILURES {
        disable(db, &sched.id).await?;
        host.notify_home(sched, &HomeNotice::Disabled(DisableReason::ConsecutiveFailures(failures)))
            .await;
    } else {
        match &sched.trigger {
            Trigger::Oneshot { .. } => {
                set_next_run(db, &sched.id, now, trunc_secs(now + to_delta(TRANSIENT_RETRY_BACKOFF))).await?;
            }
            _ => advance_after_failure(db, sched, now).await?,
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Disposition {
    Fire,
    SkipStale,
    MissedOneshot,
}

fn missed_gate(sched: &Schedule, now: DateTime<Utc>, grace: Duration) -> Disposition {
    let late = now - sched.next_run_at;
    if late <= TimeDelta::zero() {
        return Disposition::Fire;
    }
    match &sched.trigger {
        Trigger::Oneshot { .. } => {
            if late > to_delta(grace) {
                Disposition::MissedOneshot
            } else {
                Disposition::Fire
            }
        }
        Trigger::Interval { every } => {
            if late >= to_delta(*every) {
                Disposition::SkipStale
            } else {
                Disposition::Fire
            }
        }
        Trigger::Cron { .. } => match next_after(&sched.trigger, sched.next_run_at) {
            Some(following) if late >= (following - sched.next_run_at) => Disposition::SkipStale,
            _ => Disposition::Fire,
        },
    }
}

async fn sleep_target(
    db: &SqlitePool,
    moment: DateTime<Utc>,
    cap: Duration,
    in_flight: &HashSet<String>,
) -> DateTime<Utc> {
    let capped = moment + to_delta(cap);
    match nearest_active(db, in_flight).await {
        Ok(Some(next)) => next.min(capped),
        Ok(None) => capped,
        Err(e) => {
            tracing::warn!(error = ?e, "scheduler nearest-next query failed");
            capped
        }
    }
}

fn trigger_columns(trigger: &Trigger) -> (&'static str, Option<String>, Option<String>, Option<i64>) {
    match trigger {
        Trigger::Oneshot { .. } => ("oneshot", None, None, None),
        Trigger::Cron { expr, tz } => ("cron", Some(expr.clone()), Some(tz.name().to_owned()), None),
        Trigger::Interval { every } => ("interval", None, None, Some(every.as_secs() as i64)),
    }
}

fn parse_row(row: ScheduleRow) -> Option<Schedule> {
    let mode = Mode::parse(&row.mode)?;
    let state = State::parse(&row.state)?;
    let created_at = parse_ts(&row.created_at)?;
    let next_run_at = parse_ts(&row.next_run_at)?;
    let last_run_at = match row.last_run_at {
        Some(value) => Some(parse_ts(&value)?),
        None => None,
    };
    let trigger = match row.trigger_kind.as_str() {
        "oneshot" => Trigger::Oneshot { at: next_run_at },
        "cron" => Trigger::Cron {
            expr: row.cron_expr?,
            tz: row.tz?.parse().ok()?,
        },
        "interval" => Trigger::Interval {
            every: Duration::from_secs(u64::try_from(row.interval_secs?).ok()?),
        },
        _ => return None,
    };
    Some(Schedule {
        id: row.id,
        platform: row.platform,
        scope: row.scope,
        name: row.name,
        created_by: row.created_by,
        created_at,
        mode,
        origin: row.origin,
        target: row.target,
        trigger,
        script: row.script,
        prompt: row.prompt,
        next_run_at,
        last_run_at,
        consecutive_failures: row.consecutive_failures,
        state,
    })
}

fn keep_parsed(row: ScheduleRow) -> Option<Schedule> {
    let id = row.id.clone();
    let parsed = parse_row(row);
    if parsed.is_none() {
        tracing::warn!(schedule_id = %id, "skipping unparsable schedule row");
    }
    parsed
}

fn parse_cron(expr: &str) -> color_eyre::Result<cron::Schedule> {
    let six_field = format!("0 {expr}");
    six_field
        .parse::<cron::Schedule>()
        .map_err(|e| eyre!("invalid cron expression {expr:?}: {e}"))
}

fn parse_ts(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn store_ts(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn trunc_secs(dt: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp(dt.timestamp(), 0).unwrap_or(dt)
}

fn to_delta(duration: Duration) -> TimeDelta {
    TimeDelta::from_std(duration).unwrap_or(TimeDelta::MAX)
}

fn now() -> DateTime<Utc> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    DateTime::from_timestamp(secs, 0)
        .unwrap_or_else(|| DateTime::from_timestamp(0, 0).expect("unix epoch is representable"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-schedule-{tag}-{}-{seq}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn temp_db(tag: &str) -> (SqlitePool, PathBuf) {
        let dir = temp_dir(tag);
        let pool = crate::db::open(&dir).await.unwrap();
        (pool, dir)
    }

    async fn cleanup(db: SqlitePool, dir: PathBuf) {
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    fn cfg() -> ScheduleConfig {
        ScheduleConfig {
            grace: Duration::from_secs(7200),
            script_timeout: Duration::from_secs(5),
            cap: Duration::from_secs(60),
        }
    }

    fn new_interval(prompt: Option<&str>, script: Option<&str>, secs: u64) -> NewSchedule {
        NewSchedule {
            platform: "discord".to_owned(),
            scope: "guild-1".to_owned(),
            name: "test".to_owned(),
            created_by: "user-1".to_owned(),
            mode: Mode::Fresh,
            origin: "thread-1".to_owned(),
            target: "channel-1".to_owned(),
            trigger: Trigger::Interval {
                every: Duration::from_secs(secs),
            },
            script: script.map(str::to_owned),
            prompt: prompt.map(str::to_owned),
        }
    }

    fn new_oneshot(prompt: Option<&str>, script: Option<&str>, at: DateTime<Utc>) -> NewSchedule {
        NewSchedule {
            trigger: Trigger::Oneshot { at },
            ..new_interval(prompt, script, 60)
        }
    }

    fn sample_schedule(trigger: Trigger, next_run_at: DateTime<Utc>) -> Schedule {
        Schedule {
            id: "01".to_owned(),
            platform: "discord".to_owned(),
            scope: "guild-1".to_owned(),
            name: "n".to_owned(),
            created_by: "u".to_owned(),
            created_at: next_run_at,
            mode: Mode::Fresh,
            origin: "o".to_owned(),
            target: "t".to_owned(),
            trigger,
            script: None,
            prompt: Some("p".to_owned()),
            next_run_at,
            last_run_at: None,
            consecutive_failures: 0,
            state: State::Active,
        }
    }

    #[derive(Default)]
    struct FakeCalls {
        fired: Vec<String>,
        posted: Vec<String>,
        notified: Vec<HomeNotice>,
    }

    #[derive(Clone)]
    struct FakeHost {
        cwd: Option<PathBuf>,
        fire_outcome: FireOutcome,
        calls: Arc<parking_lot::Mutex<FakeCalls>>,
    }

    impl FakeHost {
        fn new() -> FakeHost {
            FakeHost {
                cwd: Some(std::env::temp_dir()),
                fire_outcome: FireOutcome::Delivered,
                calls: Arc::new(parking_lot::Mutex::new(FakeCalls::default())),
            }
        }
    }

    impl ScheduleHost for FakeHost {
        async fn resolve_cwd(&self, _sched: &Schedule) -> color_eyre::Result<Option<PathBuf>> {
            Ok(self.cwd.clone())
        }

        async fn fire(&self, _sched: &Schedule, wrapped_prompt: &str) -> FireOutcome {
            self.calls.lock().fired.push(wrapped_prompt.to_owned());
            self.fire_outcome
        }

        async fn post_raw(&self, _sched: &Schedule, text: &str) -> FireOutcome {
            self.calls.lock().posted.push(text.to_owned());
            FireOutcome::Delivered
        }

        async fn notify_home(&self, _sched: &Schedule, notice: &HomeNotice) {
            self.calls.lock().notified.push(notice.clone());
        }
    }

    #[test]
    fn next_after_interval_adds_duration() {
        let base = DateTime::from_timestamp(1_700_000_000, 0).unwrap();
        let next = next_after(
            &Trigger::Interval {
                every: Duration::from_secs(5400),
            },
            base,
        )
        .unwrap();
        assert_eq!(next, base + TimeDelta::seconds(5400));
    }

    #[test]
    fn next_after_oneshot_returns_at() {
        let at = DateTime::from_timestamp(1_800_000_000, 0).unwrap();
        let base = DateTime::from_timestamp(1_700_000_000, 0).unwrap();
        assert_eq!(next_after(&Trigger::Oneshot { at }, base).unwrap(), at);
    }

    #[test]
    fn next_after_cron_daily_nine_am_utc() {
        let trigger = Trigger::Cron {
            expr: "0 9 * * *".to_owned(),
            tz: chrono_tz::UTC,
        };
        let after = parse_ts("2026-06-24T10:00:00Z").unwrap();
        let next = next_after(&trigger, after).unwrap();
        assert_eq!(store_ts(next), "2026-06-25T09:00:00Z");
    }

    #[test]
    fn next_after_cron_day_of_week_mapping() {
        let cron_next = |expr: &str| {
            let trigger = Trigger::Cron {
                expr: expr.to_owned(),
                tz: chrono_tz::UTC,
            };
            next_after(&trigger, parse_ts("2026-06-24T12:00:00Z").unwrap()).unwrap()
        };
        let sunday = "2026-06-28T00:00:00Z";
        let monday = "2026-06-29T00:00:00Z";
        assert_eq!(store_ts(cron_next("0 0 * * 1")), sunday, "zslayton numeric dow 1 = Sunday");
        assert_eq!(store_ts(cron_next("0 0 * * 2")), monday, "zslayton numeric dow 2 = Monday");
        assert_eq!(store_ts(cron_next("0 0 * * SUN")), sunday, "name SUN = Sunday");
        assert_eq!(store_ts(cron_next("0 0 * * MON")), monday, "name MON = Monday");
    }

    #[test]
    fn validate_rejects_neither_script_nor_prompt() {
        let mut new = new_interval(None, None, 120);
        new.script = None;
        new.prompt = None;
        assert!(validate(&new).is_err());
    }

    #[test]
    fn validate_rejects_sub_minute_interval() {
        assert!(validate(&new_interval(Some("p"), None, 59)).is_err());
        assert!(validate(&new_interval(Some("p"), None, 60)).is_ok());
    }

    #[test]
    fn validate_rejects_past_oneshot() {
        let past = DateTime::from_timestamp(1_000_000_000, 0).unwrap();
        assert!(validate(&new_oneshot(Some("p"), None, past)).is_err());
        let future = now() + TimeDelta::seconds(3600);
        assert!(validate(&new_oneshot(Some("p"), None, future)).is_ok());
    }

    #[test]
    fn validate_rejects_unparseable_cron() {
        let mut new = new_interval(Some("p"), None, 120);
        new.trigger = Trigger::Cron {
            expr: "not a cron".to_owned(),
            tz: chrono_tz::UTC,
        };
        assert!(validate(&new).is_err());
    }

    #[test]
    fn missed_gate_interval_period_relative() {
        let base = now();
        let sched = sample_schedule(
            Trigger::Interval {
                every: Duration::from_secs(3600),
            },
            base,
        );
        assert_eq!(
            missed_gate(&sched, base + TimeDelta::seconds(1800), Duration::from_secs(7200)),
            Disposition::Fire
        );
        assert_eq!(
            missed_gate(&sched, base + TimeDelta::seconds(5400), Duration::from_secs(7200)),
            Disposition::SkipStale
        );
    }

    #[test]
    fn missed_gate_oneshot_honors_grace() {
        let base = now();
        let sched = sample_schedule(Trigger::Oneshot { at: base }, base);
        assert_eq!(
            missed_gate(&sched, base + TimeDelta::seconds(3600), Duration::from_secs(7200)),
            Disposition::Fire
        );
        assert_eq!(
            missed_gate(&sched, base + TimeDelta::seconds(10800), Duration::from_secs(7200)),
            Disposition::MissedOneshot
        );
    }

    #[tokio::test]
    async fn crud_round_trip_and_state_transitions() {
        let (db, dir) = temp_db("crud").await;
        let created = create(&db, new_interval(Some("hello"), None, 120)).await.unwrap();

        let loaded = get(&db, &created.id).await.unwrap().unwrap();
        assert_eq!(loaded, created);

        let listed = list(&db, "discord", "guild-1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);

        assert!(set_state(&db, &created.id, State::Disabled).await.unwrap());
        assert_eq!(get(&db, &created.id).await.unwrap().unwrap().state, State::Disabled);
        set_state(&db, &created.id, State::Active).await.unwrap();

        assert_eq!(record_failure(&db, &created.id).await.unwrap(), 1);
        assert_eq!(record_failure(&db, &created.id).await.unwrap(), 2);
        assert_eq!(record_failure(&db, &created.id).await.unwrap(), 3);
        disable(&db, &created.id).await.unwrap();
        assert_eq!(get(&db, &created.id).await.unwrap().unwrap().state, State::Disabled);

        let next = created.next_run_at + TimeDelta::seconds(120);
        advance_recurring(&db, &created.id, created.next_run_at, next)
            .await
            .unwrap();
        let advanced = get(&db, &created.id).await.unwrap().unwrap();
        assert_eq!(advanced.consecutive_failures, 0);
        assert_eq!(advanced.next_run_at, next);

        assert!(remove(&db, &created.id).await.unwrap());
        assert!(get(&db, &created.id).await.unwrap().is_none());
        cleanup(db, dir).await;
    }

    #[tokio::test]
    async fn fire_one_routes_prompt_to_fire_and_advances() {
        let (db, dir) = temp_db("fire-prompt").await;
        let sched = create(&db, new_interval(Some("do the thing"), None, 3600))
            .await
            .unwrap();
        let host = FakeHost::new();
        fire_one(&db, &host, &cfg(), &sched, sched.next_run_at).await.unwrap();
        {
            let calls = host.calls.lock();
            assert_eq!(calls.fired.len(), 1);
            assert!(calls.fired[0].contains("do the thing"));
            assert!(calls.posted.is_empty());
        }
        let reloaded = get(&db, &sched.id).await.unwrap().unwrap();
        assert!(reloaded.next_run_at > sched.next_run_at);
        assert_eq!(reloaded.state, State::Active);
        cleanup(db, dir).await;
    }

    #[tokio::test]
    async fn fire_one_routes_script_context_to_post_raw() {
        let (db, dir) = temp_db("fire-postraw").await;
        let script = "echo '{\"skip\":false,\"context\":\"digest body\"}'";
        let sched = create(&db, new_interval(None, Some(script), 3600)).await.unwrap();
        let host = FakeHost::new();
        fire_one(&db, &host, &cfg(), &sched, sched.next_run_at).await.unwrap();
        {
            let calls = host.calls.lock();
            assert_eq!(calls.posted, vec!["digest body".to_owned()]);
            assert!(calls.fired.is_empty());
        }
        cleanup(db, dir).await;
    }

    #[tokio::test]
    async fn fire_one_failure_notifies_home_and_records_failure() {
        let (db, dir) = temp_db("fire-fail").await;
        let sched = create(&db, new_interval(Some("p"), Some("exit 2"), 3600))
            .await
            .unwrap();
        let host = FakeHost::new();
        fire_one(&db, &host, &cfg(), &sched, sched.next_run_at).await.unwrap();
        {
            let calls = host.calls.lock();
            assert!(calls.fired.is_empty(), "failure must not invoke the llm");
            assert_eq!(calls.notified.len(), 1);
        }
        let reloaded = get(&db, &sched.id).await.unwrap().unwrap();
        assert_eq!(reloaded.consecutive_failures, 1);
        assert_eq!(reloaded.state, State::Active);
        assert!(reloaded.next_run_at > sched.next_run_at);
        cleanup(db, dir).await;
    }

    #[tokio::test]
    async fn fire_one_oneshot_fires_then_triggers() {
        let (db, dir) = temp_db("fire-oneshot").await;
        let at = now() + TimeDelta::seconds(3600);
        let sched = create(&db, new_oneshot(Some("ping"), None, at)).await.unwrap();
        let host = FakeHost::new();
        fire_one(&db, &host, &cfg(), &sched, sched.next_run_at).await.unwrap();
        assert_eq!(host.calls.lock().fired.len(), 1);
        let reloaded = get(&db, &sched.id).await.unwrap().unwrap();
        assert_eq!(reloaded.state, State::Triggered);
        assert!(reloaded.last_run_at.is_some());
        cleanup(db, dir).await;
    }

    #[tokio::test]
    async fn fire_one_oneshot_missed_beyond_grace_notifies_and_consumes() {
        let (db, dir) = temp_db("fire-missed").await;
        let at = now() + TimeDelta::seconds(3600);
        let sched = create(&db, new_oneshot(Some("ping"), None, at)).await.unwrap();
        let host = FakeHost::new();
        let late = sched.next_run_at + TimeDelta::seconds(3 * 3600);
        fire_one(&db, &host, &cfg(), &sched, late).await.unwrap();
        {
            let calls = host.calls.lock();
            assert!(calls.fired.is_empty());
            assert_eq!(calls.notified.len(), 1);
            assert!(matches!(calls.notified[0], HomeNotice::Missed { .. }));
        }
        assert_eq!(get(&db, &sched.id).await.unwrap().unwrap().state, State::Triggered);
        cleanup(db, dir).await;
    }

    #[tokio::test]
    async fn fire_one_recurring_stale_skips_and_advances() {
        let (db, dir) = temp_db("fire-stale").await;
        let sched = create(&db, new_interval(Some("p"), None, 3600)).await.unwrap();
        let host = FakeHost::new();
        let stale = sched.next_run_at + TimeDelta::seconds(7200);
        fire_one(&db, &host, &cfg(), &sched, stale).await.unwrap();
        assert!(host.calls.lock().fired.is_empty(), "stale recurring must not fire");
        let reloaded = get(&db, &sched.id).await.unwrap().unwrap();
        assert!(reloaded.next_run_at > sched.next_run_at);
        assert_eq!(reloaded.state, State::Active);
        cleanup(db, dir).await;
    }

    #[tokio::test]
    async fn run_boot_sweep_fires_due_schedule_then_advances() {
        let (db, dir) = temp_db("run-boot").await;
        let sched = create(&db, new_interval(Some("tick"), None, 3600)).await.unwrap();
        let past = store_ts(now() - TimeDelta::seconds(5));
        sqlx::query("UPDATE schedules SET next_run_at = ? WHERE id = ?")
            .bind(&past)
            .bind(&sched.id)
            .execute(&db)
            .await
            .unwrap();

        let host = FakeHost::new();
        let calls = Arc::clone(&host.calls);
        let cancel = CancellationToken::new();
        let driver = {
            let db = db.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { run(&db, host, cfg(), cancel).await })
        };

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while calls.lock().fired.is_empty() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        cancel.cancel();
        driver.await.unwrap();

        assert_eq!(calls.lock().fired.len(), 1, "boot sweep fires the due schedule once");
        let reloaded = get(&db, &sched.id).await.unwrap().unwrap();
        assert!(
            reloaded.next_run_at > parse_ts(&past).unwrap(),
            "schedule advanced past its due time"
        );
        assert_eq!(reloaded.state, State::Active);
        cleanup(db, dir).await;
    }

    #[tokio::test]
    async fn fire_one_transient_records_failure_and_disables_on_third() {
        let (db, dir) = temp_db("fire-transient").await;
        let created = create(&db, new_interval(Some("p"), None, 3600)).await.unwrap();
        let mut host = FakeHost::new();
        host.fire_outcome = FireOutcome::Transient;

        let mut sched = created.clone();
        for expected in 1..=2 {
            fire_one(&db, &host, &cfg(), &sched, sched.next_run_at).await.unwrap();
            let reloaded = get(&db, &sched.id).await.unwrap().unwrap();
            assert_eq!(reloaded.consecutive_failures, expected);
            assert_eq!(
                reloaded.state,
                State::Active,
                "transient blip must not disable before the limit"
            );
            assert!(
                reloaded.next_run_at > sched.next_run_at,
                "transient advances to the next period"
            );
            sched = reloaded;
        }

        fire_one(&db, &host, &cfg(), &sched, sched.next_run_at).await.unwrap();
        let reloaded = get(&db, &sched.id).await.unwrap().unwrap();
        assert_eq!(reloaded.consecutive_failures, 3);
        assert_eq!(reloaded.state, State::Disabled, "third consecutive transient failure disables");
        {
            let calls = host.calls.lock();
            assert_eq!(calls.fired.len(), 3, "every attempt fired");
            assert_eq!(
                calls.notified.len(),
                1,
                "transient fires emit no per-failure spam, only the disable notice"
            );
            assert!(
                matches!(calls.notified[0], HomeNotice::Disabled(DisableReason::ConsecutiveFailures(_))),
                "the single notice is the auto-disable notice"
            );
        }
        cleanup(db, dir).await;
    }

    #[tokio::test]
    async fn fire_one_oneshot_transient_retries_and_is_not_consumed() {
        let (db, dir) = temp_db("fire-oneshot-transient").await;
        let at = now() + TimeDelta::seconds(3600);
        let created = create(&db, new_oneshot(Some("ping"), None, at)).await.unwrap();
        let mut host = FakeHost::new();
        host.fire_outcome = FireOutcome::Transient;

        let mut sched = created.clone();
        for expected in 1..=2 {
            fire_one(&db, &host, &cfg(), &sched, sched.next_run_at).await.unwrap();
            let reloaded = get(&db, &sched.id).await.unwrap().unwrap();
            assert_eq!(reloaded.consecutive_failures, expected);
            assert_eq!(
                reloaded.state,
                State::Active,
                "a transient oneshot retries and is never consumed as Triggered"
            );
            assert!(
                reloaded.next_run_at > sched.next_run_at,
                "a transient oneshot backs off for a later retry"
            );
            sched = reloaded;
        }

        fire_one(&db, &host, &cfg(), &sched, sched.next_run_at).await.unwrap();
        let reloaded = get(&db, &sched.id).await.unwrap().unwrap();
        assert_eq!(
            reloaded.state,
            State::Disabled,
            "the third consecutive transient failure disables the oneshot, never silently Triggered"
        );
        cleanup(db, dir).await;
    }
}
