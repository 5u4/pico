use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use color_eyre::eyre::{WrapErr, eyre};
use notify::{RecursiveMode, Watcher};
use pico_shared::paths::{find_schedule_dir, schedule_dir, schedule_state_dir, schedules_dir};
use serde::{Deserialize, Serialize};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{config::ScheduleConfig, prompt};

mod gate;

pub const SCRIPT_FILE: &str = "script.sh";
pub const PROMPT_FILE: &str = "prompt.md";
const DEFINITION_FILE: &str = "schedule.toml";
const STATE_FILE: &str = "state.json";
const RUNS_DIR: &str = "runs";
const STDOUT_FILE: &str = "stdout";
const STDERR_FILE: &str = "stderr";
const META_FILE: &str = "meta.json";
const TRIGGER_FILE: &str = "trigger";

const ALL_STATES: [State; 3] = [State::Active, State::Disabled, State::Triggered];

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
    MissingDefinition,
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

pub struct Definition {
    pub script: Option<String>,
    pub prompt: Option<String>,
    pub script_path: PathBuf,
    pub prompt_path: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DefinitionToml {
    name: String,
    created_by: String,
    created_at: String,
    mode: String,
    platform: String,
    scope: String,
    origin: String,
    target: String,
    trigger: TriggerToml,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TriggerToml {
    Oneshot { at: String },
    Cron { expr: String, tz: String },
    Interval { every_secs: u64 },
}

#[derive(Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RuntimeState {
    #[serde(default)]
    next_run_at: Option<String>,
    #[serde(default)]
    last_run_at: Option<String>,
    #[serde(default)]
    consecutive_failures: i64,
}

#[derive(Serialize)]
struct RunMeta {
    fired_at: String,
    trigger: String,
    gate: String,
    outcome: String,
    exit: Option<i32>,
    prompt: Option<String>,
}

fn trigger_to_toml(trigger: &Trigger) -> TriggerToml {
    match trigger {
        Trigger::Oneshot { at } => TriggerToml::Oneshot { at: store_ts(*at) },
        Trigger::Cron { expr, tz } => TriggerToml::Cron {
            expr: expr.clone(),
            tz: tz.name().to_owned(),
        },
        Trigger::Interval { every } => TriggerToml::Interval {
            every_secs: every.as_secs(),
        },
    }
}

fn trigger_from_toml(trigger: TriggerToml) -> Option<Trigger> {
    match trigger {
        TriggerToml::Oneshot { at } => Some(Trigger::Oneshot { at: parse_ts(&at)? }),
        TriggerToml::Cron { expr, tz } => Some(Trigger::Cron {
            expr,
            tz: tz.parse().ok()?,
        }),
        TriggerToml::Interval { every_secs } => Some(Trigger::Interval {
            every: Duration::from_secs(every_secs),
        }),
    }
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().chars() {
        let mapped = if ch.is_whitespace() { '-' } else { ch };
        if mapped == '/' || mapped == '\\' || mapped == ':' || mapped == '\0' || mapped.is_control() {
            continue;
        }
        if mapped == '-' && out.ends_with('-') {
            continue;
        }
        out.push(if mapped.is_ascii_uppercase() {
            mapped.to_ascii_lowercase()
        } else {
            mapped
        });
    }
    let truncated: String = out.chars().take(64).collect();
    let slug = truncated.trim_matches(|c| c == '-' || c == '.').to_owned();
    if slug.is_empty() { "job".to_owned() } else { slug }
}

fn stamp(dt: DateTime<Utc>, tz: Option<chrono_tz::Tz>) -> String {
    match tz {
        Some(tz) => dt.with_timezone(&tz).format("%Y%m%d%H%M%S").to_string(),
        None => dt.with_timezone(&chrono::Local).format("%Y%m%d%H%M%S").to_string(),
    }
}

fn allocate_id(root: &Path, stamp: &str, slug: &str) -> String {
    let base = format!("{stamp}-{slug}");
    if find_schedule_dir(root, &base).is_none() {
        return base;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if find_schedule_dir(root, &candidate).is_none() {
            return candidate;
        }
        n += 1;
    }
}

fn write_definition(
    dir: &Path,
    new: &NewSchedule,
    created_at: DateTime<Utc>,
    next_run_at: DateTime<Utc>,
) -> color_eyre::Result<()> {
    fs::create_dir_all(dir).wrap_err("creating schedule directory")?;
    let def = DefinitionToml {
        name: new.name.clone(),
        created_by: new.created_by.clone(),
        created_at: store_ts(created_at),
        mode: new.mode.as_str().to_owned(),
        platform: new.platform.clone(),
        scope: new.scope.clone(),
        origin: new.origin.clone(),
        target: new.target.clone(),
        trigger: trigger_to_toml(&new.trigger),
    };
    let serialized = toml::to_string(&def).wrap_err("serializing schedule.toml")?;
    fs::write(dir.join(DEFINITION_FILE), serialized).wrap_err("writing schedule.toml")?;
    if let Some(script) = &new.script {
        fs::write(dir.join(SCRIPT_FILE), script).wrap_err("writing schedule script")?;
    }
    if let Some(prompt) = &new.prompt {
        fs::write(dir.join(PROMPT_FILE), prompt).wrap_err("writing schedule prompt")?;
    }
    write_state(
        dir,
        &RuntimeState {
            next_run_at: Some(store_ts(next_run_at)),
            last_run_at: None,
            consecutive_failures: 0,
        },
    )?;
    Ok(())
}

fn write_state(dir: &Path, state: &RuntimeState) -> color_eyre::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let serialized = serde_json::to_string_pretty(state).wrap_err("serializing state.json")?;
    let unique = format!(".state.json.{}.{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed));
    let tmp = dir.join(unique);
    fs::write(&tmp, serialized).wrap_err("writing state.json")?;
    fs::rename(&tmp, dir.join(STATE_FILE)).wrap_err("publishing state.json")?;
    Ok(())
}

fn read_state(dir: &Path) -> Option<RuntimeState> {
    let raw = fs::read_to_string(dir.join(STATE_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn load_schedule(dir: &Path, state: State) -> Option<Schedule> {
    let id = dir.file_name()?.to_str()?.to_owned();
    let raw = fs::read_to_string(dir.join(DEFINITION_FILE)).ok()?;
    let def: DefinitionToml = toml::from_str(&raw).ok()?;
    let mode = Mode::parse(&def.mode)?;
    let created_at = parse_ts(&def.created_at)?;
    let trigger = trigger_from_toml(def.trigger)?;
    let runtime = read_state(dir);
    let last_run_at = runtime
        .as_ref()
        .and_then(|r| r.last_run_at.as_deref())
        .and_then(parse_ts);
    let consecutive_failures = runtime.as_ref().map(|r| r.consecutive_failures).unwrap_or(0);
    let next_run_at = runtime
        .as_ref()
        .and_then(|r| r.next_run_at.as_deref())
        .and_then(parse_ts)
        .or_else(|| next_after(&trigger, created_at).map(trunc_secs))?;
    let trigger = match trigger {
        Trigger::Oneshot { .. } => Trigger::Oneshot { at: next_run_at },
        other => other,
    };
    Some(Schedule {
        id,
        platform: def.platform,
        scope: def.scope,
        name: def.name,
        created_by: def.created_by,
        created_at,
        mode,
        origin: def.origin,
        target: def.target,
        trigger,
        next_run_at,
        last_run_at,
        consecutive_failures,
        state,
    })
}

fn scan_state(root: &Path, state: State) -> Vec<Schedule> {
    let dir = schedule_state_dir(root, state.as_str());
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match load_schedule(&path, state) {
            Some(sched) => out.push(sched),
            None => tracing::warn!(dir = %path.display(), "skipping unparsable schedule folder"),
        }
    }
    out
}

async fn read_part(path: &Path) -> io::Result<Option<String>> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn move_to(root: &Path, from: &Path, id: &str, state: State) -> color_eyre::Result<PathBuf> {
    let target = schedule_dir(root, state.as_str(), id);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).wrap_err("creating schedule state directory")?;
    }
    fs::rename(from, &target).wrap_err("moving schedule directory")?;
    Ok(target)
}

pub async fn create(root: &Path, new: NewSchedule, tz: Option<chrono_tz::Tz>) -> color_eyre::Result<Schedule> {
    validate(&new)?;
    let created_at = now();
    let next_run_at =
        trunc_secs(next_after(&new.trigger, created_at).ok_or_else(|| eyre!("trigger has no upcoming occurrence"))?);
    let id = allocate_id(root, &stamp(created_at, tz), &slugify(&new.name));
    let staging = schedule_state_dir(root, ".staging").join(format!("{id}.{}", std::process::id()));
    fs::remove_dir_all(&staging).ok();
    let dir = schedule_dir(root, State::Active.as_str(), &id);
    let published = write_definition(&staging, &new, created_at, next_run_at).and_then(|()| {
        if let Some(parent) = dir.parent() {
            fs::create_dir_all(parent).wrap_err("creating active schedule directory")?;
        }
        fs::rename(&staging, &dir).wrap_err("publishing schedule directory")
    });
    if let Err(e) = published {
        fs::remove_dir_all(&staging).ok();
        return Err(e);
    }
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
        next_run_at,
        last_run_at: None,
        consecutive_failures: 0,
        state: State::Active,
    })
}

pub async fn list(root: &Path, platform: &str, scope: &str) -> color_eyre::Result<Vec<Schedule>> {
    let mut all: Vec<Schedule> = ALL_STATES
        .into_iter()
        .flat_map(|state| scan_state(root, state))
        .filter(|sched| sched.platform == platform && sched.scope == scope)
        .collect();
    all.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    Ok(all)
}

pub async fn get(root: &Path, id: &str) -> color_eyre::Result<Option<Schedule>> {
    Ok(find_schedule_dir(root, id)
        .and_then(|(state, dir)| State::parse(state).and_then(|state| load_schedule(&dir, state))))
}

pub async fn remove(root: &Path, id: &str) -> color_eyre::Result<bool> {
    match find_schedule_dir(root, id) {
        Some((_, dir)) => {
            fs::remove_dir_all(&dir).wrap_err("removing schedule directory")?;
            Ok(true)
        }
        None => Ok(false),
    }
}

pub async fn set_state(root: &Path, id: &str, state: State) -> color_eyre::Result<bool> {
    let Some((current, dir)) = find_schedule_dir(root, id) else {
        return Ok(false);
    };
    if current != state.as_str() {
        move_to(root, &dir, id, state)?;
    }
    Ok(true)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriggerOutcome {
    Triggered,
    NotFound,
    Inactive(State),
}

pub async fn trigger(root: &Path, id: &str) -> color_eyre::Result<TriggerOutcome> {
    let Some(sched) = get(root, id).await? else {
        return Ok(TriggerOutcome::NotFound);
    };
    if sched.state != State::Active {
        return Ok(TriggerOutcome::Inactive(sched.state));
    }
    let marker = schedule_dir(root, State::Active.as_str(), id).join(TRIGGER_FILE);
    fs::write(&marker, []).wrap_err_with(|| format!("writing trigger marker for {id}"))?;
    Ok(TriggerOutcome::Triggered)
}

pub async fn read_definition(root: &Path, id: &str) -> io::Result<Definition> {
    let dir = match find_schedule_dir(root, id) {
        Some((_, dir)) => dir,
        None => return Err(io::Error::new(io::ErrorKind::NotFound, format!("no schedule {id}"))),
    };
    let script = read_part(&dir.join(SCRIPT_FILE)).await?;
    let prompt = read_part(&dir.join(PROMPT_FILE)).await?;
    Ok(Definition {
        script,
        prompt,
        script_path: dir.join(SCRIPT_FILE),
        prompt_path: dir.join(PROMPT_FILE),
    })
}

pub async fn due(root: &Path, now: DateTime<Utc>) -> color_eyre::Result<Vec<Schedule>> {
    let mut rows: Vec<Schedule> = scan_state(root, State::Active)
        .into_iter()
        .filter(|sched| sched.next_run_at <= now || has_trigger_marker(root, &sched.id))
        .collect();
    rows.sort_by_key(|sched| sched.next_run_at);
    Ok(rows)
}

fn has_trigger_marker(root: &Path, id: &str) -> bool {
    schedule_dir(root, State::Active.as_str(), id)
        .join(TRIGGER_FILE)
        .exists()
}

fn nearest_active(root: &Path, exclude: &HashSet<String>) -> Option<DateTime<Utc>> {
    scan_state(root, State::Active)
        .into_iter()
        .filter(|sched| !exclude.contains(&sched.id))
        .map(|sched| sched.next_run_at)
        .min()
}

fn update_state(root: &Path, id: &str, edit: impl FnOnce(&mut RuntimeState)) -> color_eyre::Result<()> {
    let Some((_, dir)) = find_schedule_dir(root, id) else {
        return Ok(());
    };
    let mut state = read_state(&dir).unwrap_or_default();
    edit(&mut state);
    write_state(&dir, &state)
}

async fn advance_recurring(
    root: &Path,
    id: &str,
    last_run_at: DateTime<Utc>,
    next_run_at: DateTime<Utc>,
) -> color_eyre::Result<()> {
    update_state(root, id, |state| {
        state.last_run_at = Some(store_ts(last_run_at));
        state.next_run_at = Some(store_ts(next_run_at));
        state.consecutive_failures = 0;
    })
}

async fn set_next_run(
    root: &Path,
    id: &str,
    last_run_at: DateTime<Utc>,
    next_run_at: DateTime<Utc>,
) -> color_eyre::Result<()> {
    update_state(root, id, |state| {
        state.last_run_at = Some(store_ts(last_run_at));
        state.next_run_at = Some(store_ts(next_run_at));
    })
}

async fn record_failure(root: &Path, id: &str) -> color_eyre::Result<i64> {
    let Some((_, dir)) = find_schedule_dir(root, id) else {
        return Ok(0);
    };
    let mut state = read_state(&dir).unwrap_or_default();
    state.consecutive_failures += 1;
    let count = state.consecutive_failures;
    write_state(&dir, &state)?;
    Ok(count)
}

async fn disable(root: &Path, id: &str) -> color_eyre::Result<()> {
    if let Some((current, dir)) = find_schedule_dir(root, id)
        && current != State::Disabled.as_str()
    {
        move_to(root, &dir, id, State::Disabled)?;
    }
    Ok(())
}

async fn finish_oneshot(root: &Path, id: &str, last_run_at: Option<DateTime<Utc>>) -> color_eyre::Result<()> {
    if let Some((current, dir)) = find_schedule_dir(root, id) {
        if let Some(last) = last_run_at {
            let mut state = read_state(&dir).unwrap_or_default();
            state.last_run_at = Some(store_ts(last));
            if let Err(e) = write_state(&dir, &state) {
                tracing::warn!(schedule_id = %id, error = %format!("{e:#}"), "persisting oneshot last_run_at failed");
            }
        }
        if current != State::Triggered.as_str() {
            move_to(root, &dir, id, State::Triggered)?;
        }
    }
    Ok(())
}

fn create_run_dir(root: &Path, id: &str, fired_at: DateTime<Utc>, tz: Option<chrono_tz::Tz>) -> Option<PathBuf> {
    let (_, dir) = find_schedule_dir(root, id)?;
    let run = dir.join(RUNS_DIR).join(stamp(fired_at, tz));
    fs::create_dir_all(&run).ok()?;
    Some(run)
}

fn write_capture(run_dir: &Path, capture: &gate::RunCapture) {
    if !capture.stdout.is_empty() {
        fs::write(run_dir.join(STDOUT_FILE), &capture.stdout).ok();
    }
    if !capture.stderr.is_empty() {
        fs::write(run_dir.join(STDERR_FILE), &capture.stderr).ok();
    }
}

#[allow(clippy::too_many_arguments)]
fn write_meta(
    run_dir: Option<&Path>,
    sched: &Schedule,
    fired_at: DateTime<Utc>,
    gate: &str,
    outcome: &str,
    exit: Option<i32>,
    prompt: Option<&str>,
) {
    let Some(dir) = run_dir else {
        return;
    };
    let meta = RunMeta {
        fired_at: store_ts(fired_at),
        trigger: sched.trigger.describe(),
        gate: gate.to_owned(),
        outcome: outcome.to_owned(),
        exit,
        prompt: prompt.map(str::to_owned),
    };
    if let Ok(serialized) = serde_json::to_string_pretty(&meta) {
        fs::write(dir.join(META_FILE), serialized).ok();
    }
}

fn prune_runs(root: &Path, id: &str, keep: usize) {
    let Some((_, dir)) = find_schedule_dir(root, id) else {
        return;
    };
    let runs = dir.join(RUNS_DIR);
    let mut dirs: Vec<PathBuf> = match fs::read_dir(&runs) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect(),
        Err(_) => return,
    };
    dirs.sort();
    if dirs.len() > keep {
        for old in &dirs[..dirs.len() - keep] {
            fs::remove_dir_all(old).ok();
        }
    }
}

const MAX_CONSECUTIVE_FAILURES: i64 = 3;
const MIN_IDLE: Duration = Duration::from_secs(1);
const TRANSIENT_RETRY_BACKOFF: Duration = Duration::from_secs(300);

pub async fn run<H: ScheduleHost + 'static>(host: H, cfg: ScheduleConfig, root: PathBuf, cancel: CancellationToken) {
    let host = Arc::new(host);
    let root = Arc::new(root);
    let tracker = TaskTracker::new();
    let in_flight: Arc<parking_lot::Mutex<HashSet<String>>> = Arc::new(parking_lot::Mutex::new(HashSet::new()));

    let (wake_tx, mut wake_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let watch_dir = schedules_dir(root.as_path());
    let _watcher = {
        let _ = fs::create_dir_all(&watch_dir);
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                let _ = wake_tx.send(());
            }
        }) {
            Ok(mut w) => match w.watch(&watch_dir, RecursiveMode::Recursive) {
                Ok(()) => Some(w),
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), "scheduler filesystem watch failed; falling back to poll only");
                    None
                }
            },
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "creating scheduler filesystem watcher failed; falling back to poll only");
                None
            }
        }
    };

    loop {
        if cancel.is_cancelled() {
            break;
        }
        let moment = now();
        match due(root.as_path(), moment).await {
            Ok(rows) => {
                for sched in rows {
                    if !in_flight.lock().insert(sched.id.clone()) {
                        continue;
                    }
                    let host = Arc::clone(&host);
                    let in_flight = Arc::clone(&in_flight);
                    let id = sched.id.clone();
                    let root = Arc::clone(&root);
                    tracker.spawn(async move {
                        if let Err(e) = fire_one(host.as_ref(), &cfg, root.as_path(), &sched, moment).await {
                            tracing::warn!(schedule_id = %sched.id, error = %format!("{e:#}"), "scheduled fire failed");
                        }
                        in_flight.lock().remove(&id);
                    });
                }
            }
            Err(e) => tracing::warn!(error = %format!("{e:#}"), "scheduler due scan failed"),
        }

        let after = now();
        let snapshot = in_flight.lock().clone();
        let target = sleep_target(root.as_path(), after, cfg.cap, &snapshot);
        let wait = (target - after).to_std().unwrap_or(Duration::ZERO);
        let wait = if wait.is_zero() { MIN_IDLE } else { wait };
        tokio::select! {
            () = cancel.cancelled() => break,
            () = tokio::time::sleep(wait) => {}
            Some(()) = wake_rx.recv() => {
                while wake_rx.try_recv().is_ok() {}
            }
        }
    }

    tracker.close();
    tracker.wait().await;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Next {
    AdvanceOrFinish,
    Disable(DisableReasonKind),
    Transient,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DisableReasonKind {
    OriginUnreachable,
    TargetUnreachable,
}

impl DisableReasonKind {
    fn reason(self) -> DisableReason {
        match self {
            DisableReasonKind::OriginUnreachable => DisableReason::OriginUnreachable,
            DisableReasonKind::TargetUnreachable => DisableReason::TargetUnreachable,
        }
    }
}

#[tracing::instrument(level = "info", skip_all, fields(schedule_id = %sched.id, name = %sched.name, trigger = ?sched.trigger))]
pub async fn fire_one<H: ScheduleHost>(
    host: &H,
    cfg: &ScheduleConfig,
    root: &Path,
    sched: &Schedule,
    now: DateTime<Utc>,
) -> color_eyre::Result<()> {
    let manual = consume_trigger_marker(root, &sched.id);
    if !manual {
        match missed_gate(sched, now, cfg.grace) {
            Disposition::MissedOneshot => {
                tracing::info!("missed oneshot schedule");
                host.notify_home(sched, &HomeNotice::Missed { due: sched.next_run_at })
                    .await;
                finish_oneshot(root, &sched.id, None).await?;
                return Ok(());
            }
            Disposition::SkipStale => {
                tracing::info!("skipping stale schedule run");
                advance_or_finish(root, sched, now).await?;
                return Ok(());
            }
            Disposition::Fire => {}
        }
    }
    tracing::info!("schedule fire start");

    let def = match read_definition(root, &sched.id).await {
        Ok(def) => def,
        Err(e) => {
            tracing::warn!(schedule_id = %sched.id, error = %format!("{e:#}"), "reading schedule definition failed");
            return record_transient(host, root, sched, now).await;
        }
    };
    if def.script.is_none() && def.prompt.is_none() {
        tracing::info!(reason = ?DisableReason::MissingDefinition, "disabling schedule");
        disable(root, &sched.id).await?;
        host.notify_home(sched, &HomeNotice::Disabled(DisableReason::MissingDefinition))
            .await;
        return Ok(());
    }

    let cwd = match host.resolve_cwd(sched).await {
        Ok(Some(cwd)) => cwd,
        Ok(None) => {
            tracing::info!(reason = ?DisableReason::TargetUnresolvable, "disabling schedule");
            disable(root, &sched.id).await?;
            host.notify_home(sched, &HomeNotice::Disabled(DisableReason::TargetUnresolvable))
                .await;
            return Ok(());
        }
        Err(e) => {
            tracing::warn!(schedule_id = %sched.id, error = %format!("{e:#}"), "resolving scheduled cwd failed");
            return record_transient(host, root, sched, now).await;
        }
    };

    let (gate, capture) = gate::run_script(def.script.as_deref(), &cwd, cfg.script_timeout).await;
    let run_dir = create_run_dir(root, &sched.id, now, cfg.timezone);
    if let Some(run_dir) = &run_dir {
        write_capture(run_dir, &capture);
    }

    match gate {
        gate::Gate::Skip => {
            tracing::debug!("schedule gate skip");
            write_meta(run_dir.as_deref(), sched, now, "skip", "skipped", capture.exit, None);
            post_fire(root, sched, now, manual).await?;
        }
        gate::Gate::Failure { reason, stderr_tail } => {
            write_meta(run_dir.as_deref(), sched, now, "failure", "script_failed", capture.exit, None);
            host.notify_home(sched, &HomeNotice::ScriptFailed { reason, stderr_tail })
                .await;
            record_transient(host, root, sched, now).await?;
        }
        gate::Gate::Proceed { context } => {
            tracing::debug!("schedule gate proceed");
            let (next, outcome, prompt_sent) = fire_and_classify(host, sched, now, def.prompt, context).await;
            tracing::info!(outcome = %outcome, "schedule fire outcome");
            write_meta(
                run_dir.as_deref(),
                sched,
                now,
                "proceed",
                outcome,
                capture.exit,
                prompt_sent.as_deref(),
            );
            match next {
                Next::AdvanceOrFinish => post_fire(root, sched, now, manual).await?,
                Next::Disable(kind) => {
                    tracing::info!(reason = ?kind.reason(), "disabling schedule");
                    disable(root, &sched.id).await?;
                    host.notify_home(sched, &HomeNotice::Disabled(kind.reason())).await;
                }
                Next::Transient => record_transient(host, root, sched, now).await?,
            }
        }
    }

    if run_dir.is_some() {
        prune_runs(root, &sched.id, cfg.run_history);
    }
    Ok(())
}

async fn fire_and_classify<H: ScheduleHost>(
    host: &H,
    sched: &Schedule,
    now: DateTime<Utc>,
    prompt: Option<String>,
    context: Option<String>,
) -> (Next, &'static str, Option<String>) {
    if let Some(prompt_body) = &prompt {
        let wrapped = prompt::wrap_scheduled_job(
            &sched.name,
            &sched.trigger.describe(),
            &store_ts(now),
            prompt_body,
            context.as_deref(),
        );
        let next = match host.fire(sched, &wrapped).await {
            FireOutcome::Delivered => (Next::AdvanceOrFinish, "delivered"),
            FireOutcome::TargetGone => (Next::Disable(DisableReasonKind::OriginUnreachable), "target_gone"),
            FireOutcome::Transient => (Next::Transient, "transient"),
        };
        (next.0, next.1, Some(wrapped))
    } else if let Some(text) = context.as_deref().filter(|c| !c.trim().is_empty()) {
        let next = match host.post_raw(sched, text).await {
            FireOutcome::Delivered => (Next::AdvanceOrFinish, "delivered"),
            FireOutcome::TargetGone => (Next::Disable(DisableReasonKind::TargetUnreachable), "target_gone"),
            FireOutcome::Transient => (Next::Transient, "transient"),
        };
        (next.0, next.1, Some(text.to_owned()))
    } else {
        (Next::AdvanceOrFinish, "noop", None)
    }
}

async fn advance_or_finish(root: &Path, sched: &Schedule, now: DateTime<Utc>) -> color_eyre::Result<()> {
    match &sched.trigger {
        Trigger::Oneshot { .. } => finish_oneshot(root, &sched.id, Some(now)).await,
        trigger => match next_after(trigger, now) {
            Some(next) => {
                let next_run_at = trunc_secs(next);
                tracing::debug!(next_run_at = %next_run_at, "advancing schedule next run");
                advance_recurring(root, &sched.id, now, next_run_at).await
            }
            None => disable(root, &sched.id).await,
        },
    }
}

async fn advance_after_failure(root: &Path, sched: &Schedule, now: DateTime<Utc>) -> color_eyre::Result<()> {
    match &sched.trigger {
        Trigger::Oneshot { .. } => finish_oneshot(root, &sched.id, Some(now)).await,
        trigger => match next_after(trigger, now) {
            Some(next) => set_next_run(root, &sched.id, now, trunc_secs(next)).await,
            None => disable(root, &sched.id).await,
        },
    }
}

fn consume_trigger_marker(root: &Path, id: &str) -> bool {
    let Some((_, dir)) = find_schedule_dir(root, id) else {
        return false;
    };
    match fs::remove_file(dir.join(TRIGGER_FILE)) {
        Ok(()) => true,
        Err(e) => {
            if e.kind() != io::ErrorKind::NotFound {
                tracing::warn!(schedule_id = %id, error = %e, "removing trigger marker failed");
            }
            false
        }
    }
}

async fn post_fire(root: &Path, sched: &Schedule, now: DateTime<Utc>, manual: bool) -> color_eyre::Result<()> {
    if !manual {
        return advance_or_finish(root, sched, now).await;
    }
    match &sched.trigger {
        Trigger::Oneshot { .. } => finish_oneshot(root, &sched.id, Some(now)).await,
        _ if sched.next_run_at > now => touch_last_run(root, &sched.id, now).await,
        _ => advance_or_finish(root, sched, now).await,
    }
}

async fn touch_last_run(root: &Path, id: &str, last_run_at: DateTime<Utc>) -> color_eyre::Result<()> {
    update_state(root, id, |state| {
        state.last_run_at = Some(store_ts(last_run_at));
        state.consecutive_failures = 0;
    })
}

async fn record_transient<H: ScheduleHost>(
    host: &H,
    root: &Path,
    sched: &Schedule,
    now: DateTime<Utc>,
) -> color_eyre::Result<()> {
    let failures = record_failure(root, &sched.id).await?;
    if failures >= MAX_CONSECUTIVE_FAILURES {
        disable(root, &sched.id).await?;
        host.notify_home(sched, &HomeNotice::Disabled(DisableReason::ConsecutiveFailures(failures)))
            .await;
    } else {
        match &sched.trigger {
            Trigger::Oneshot { .. } => {
                set_next_run(root, &sched.id, now, trunc_secs(now + to_delta(TRANSIENT_RETRY_BACKOFF))).await?;
            }
            _ => advance_after_failure(root, sched, now).await?,
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

fn sleep_target(root: &Path, moment: DateTime<Utc>, cap: Duration, in_flight: &HashSet<String>) -> DateTime<Utc> {
    let capped = moment + to_delta(cap);
    match nearest_active(root, in_flight) {
        Some(next) => next.min(capped),
        None => capped,
    }
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
    use super::*;

    fn cfg() -> ScheduleConfig {
        ScheduleConfig {
            grace: Duration::from_secs(7200),
            script_timeout: Duration::from_secs(5),
            cap: Duration::from_secs(60),
            timezone: Some(chrono_tz::UTC),
            run_history: 20,
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
            next_run_at,
            last_run_at: None,
            consecutive_failures: 0,
            state: State::Active,
        }
    }

    fn backdate(root: &Path, id: &str, to: DateTime<Utc>) {
        let (_, dir) = find_schedule_dir(root, id).unwrap();
        let mut state = read_state(&dir).unwrap_or_default();
        state.next_run_at = Some(store_ts(to));
        write_state(&dir, &state).unwrap();
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
    fn slugify_keeps_cjk_and_sanitizes() {
        assert_eq!(slugify("Walk the Dog"), "walk-the-dog");
        assert_eq!(slugify("遛狗 提醒"), "遛狗-提醒");
        assert_eq!(slugify("  ///  "), "job");
        assert_eq!(slugify("a//b:c"), "abc");
        assert_eq!(slugify("..hidden.."), "hidden");
        assert_eq!(slugify("a   b"), "a-b");
    }

    #[test]
    fn allocate_id_appends_on_collision() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        fs::create_dir_all(schedule_dir(r, "active", "20260101000000-x")).unwrap();
        assert_eq!(allocate_id(r, "20260101000000", "x"), "20260101000000-x-2");
        fs::create_dir_all(schedule_dir(r, "disabled", "20260101000000-x-2")).unwrap();
        assert_eq!(allocate_id(r, "20260101000000", "x"), "20260101000000-x-3");
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
        assert_eq!(store_ts(cron_next("0 0 * * 1")), "2026-06-28T00:00:00Z");
        assert_eq!(store_ts(cron_next("0 0 * * SUN")), "2026-06-28T00:00:00Z");
        assert_eq!(store_ts(cron_next("0 0 * * MON")), "2026-06-29T00:00:00Z");
    }

    #[test]
    fn validate_guards() {
        let mut new = new_interval(None, None, 120);
        new.script = None;
        new.prompt = None;
        assert!(validate(&new).is_err());
        assert!(validate(&new_interval(Some("p"), None, 59)).is_err());
        assert!(validate(&new_interval(Some("p"), None, 60)).is_ok());
        let past = DateTime::from_timestamp(1_000_000_000, 0).unwrap();
        assert!(validate(&new_oneshot(Some("p"), None, past)).is_err());
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
    async fn create_writes_definition_and_state_files() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let created = create(
            r,
            new_interval(Some("hello prompt"), Some("echo hi"), 3600),
            Some(chrono_tz::UTC),
        )
        .await
        .unwrap();
        let dir = schedule_dir(r, "active", &created.id);
        assert!(dir.join(DEFINITION_FILE).exists());
        assert!(dir.join(STATE_FILE).exists());
        assert_eq!(fs::read_to_string(dir.join(SCRIPT_FILE)).unwrap(), "echo hi");
        assert_eq!(fs::read_to_string(dir.join(PROMPT_FILE)).unwrap(), "hello prompt");

        let prompt_only = create(r, new_interval(Some("just prompt"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let prompt_dir = schedule_dir(r, "active", &prompt_only.id);
        assert!(prompt_dir.join(PROMPT_FILE).exists());
        assert!(!prompt_dir.join(SCRIPT_FILE).exists());

        let def = read_definition(r, &created.id).await.unwrap();
        assert_eq!(def.script.as_deref(), Some("echo hi"));
        assert_eq!(def.prompt.as_deref(), Some("hello prompt"));
    }

    #[tokio::test]
    async fn crud_round_trip_and_state_transitions_move_folders() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let created = create(r, new_interval(Some("hello"), None, 120), Some(chrono_tz::UTC))
            .await
            .unwrap();

        assert_eq!(get(r, &created.id).await.unwrap().unwrap(), created);
        let listed = list(r, "discord", "guild-1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(list(r, "discord", "other").await.unwrap().is_empty());

        assert!(set_state(r, &created.id, State::Disabled).await.unwrap());
        assert!(!schedule_dir(r, "active", &created.id).exists());
        assert!(schedule_dir(r, "disabled", &created.id).exists());
        assert_eq!(get(r, &created.id).await.unwrap().unwrap().state, State::Disabled);
        set_state(r, &created.id, State::Active).await.unwrap();

        assert_eq!(record_failure(r, &created.id).await.unwrap(), 1);
        assert_eq!(record_failure(r, &created.id).await.unwrap(), 2);
        let next = created.next_run_at + TimeDelta::seconds(120);
        advance_recurring(r, &created.id, created.next_run_at, next)
            .await
            .unwrap();
        let advanced = get(r, &created.id).await.unwrap().unwrap();
        assert_eq!(advanced.consecutive_failures, 0);
        assert_eq!(advanced.next_run_at, next);

        assert!(remove(r, &created.id).await.unwrap());
        assert!(get(r, &created.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn missing_state_recomputes_next_run() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let created = create(r, new_interval(Some("p"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        fs::remove_file(schedule_dir(r, "active", &created.id).join(STATE_FILE)).unwrap();
        let reloaded = get(r, &created.id).await.unwrap().unwrap();
        assert_eq!(reloaded.next_run_at, created.next_run_at);
        assert_eq!(reloaded.consecutive_failures, 0);
        assert!(reloaded.last_run_at.is_none());
    }

    #[tokio::test]
    async fn fire_one_routes_prompt_to_fire_and_advances() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let sched = create(r, new_interval(Some("do the thing"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let host = FakeHost::new();
        fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
        {
            let calls = host.calls.lock();
            assert_eq!(calls.fired.len(), 1);
            assert!(calls.fired[0].contains("do the thing"));
            assert!(calls.posted.is_empty());
        }
        let reloaded = get(r, &sched.id).await.unwrap().unwrap();
        assert!(reloaded.next_run_at > sched.next_run_at);
        assert_eq!(reloaded.state, State::Active);
    }

    #[tokio::test]
    async fn fire_one_routes_script_context_to_post_raw() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let script = "echo '{\"skip\":false,\"context\":\"digest body\"}'";
        let sched = create(r, new_interval(None, Some(script), 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let host = FakeHost::new();
        fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
        let calls = host.calls.lock();
        assert_eq!(calls.posted, vec!["digest body".to_owned()]);
        assert!(calls.fired.is_empty());
    }

    #[tokio::test]
    async fn fire_one_writes_run_log() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let script = "echo out; echo '{\"skip\":false,\"context\":\"c\"}'";
        let sched = create(r, new_interval(None, Some(script), 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let host = FakeHost::new();
        fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
        let runs = schedule_dir(r, "active", &sched.id).join(RUNS_DIR);
        let entries: Vec<PathBuf> = fs::read_dir(&runs).unwrap().flatten().map(|e| e.path()).collect();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].join(META_FILE).exists());
        assert!(entries[0].join(STDOUT_FILE).exists());
    }

    #[test]
    fn prune_runs_keeps_newest() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let id = "20260101000000-x";
        let runs = schedule_dir(r, "active", id).join(RUNS_DIR);
        for stamp in ["20260101000001", "20260101000002", "20260101000003"] {
            fs::create_dir_all(runs.join(stamp)).unwrap();
        }
        prune_runs(r, id, 2);
        let mut kept: Vec<String> = fs::read_dir(&runs)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        kept.sort();
        assert_eq!(kept, vec!["20260101000002", "20260101000003"]);
    }

    #[tokio::test]
    async fn fire_one_failure_notifies_home_and_records_failure() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let sched = create(r, new_interval(Some("p"), Some("exit 2"), 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let host = FakeHost::new();
        fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
        {
            let calls = host.calls.lock();
            assert!(calls.fired.is_empty());
            assert_eq!(calls.notified.len(), 1);
        }
        let reloaded = get(r, &sched.id).await.unwrap().unwrap();
        assert_eq!(reloaded.consecutive_failures, 1);
        assert_eq!(reloaded.state, State::Active);
        assert!(reloaded.next_run_at > sched.next_run_at);
    }

    #[tokio::test]
    async fn fire_one_oneshot_fires_then_moves_to_triggered() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let at = now() + TimeDelta::seconds(3600);
        let sched = create(r, new_oneshot(Some("ping"), None, at), Some(chrono_tz::UTC))
            .await
            .unwrap();
        assert!(schedule_dir(r, "active", &sched.id).exists());
        let host = FakeHost::new();
        fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
        assert_eq!(host.calls.lock().fired.len(), 1);
        assert!(!schedule_dir(r, "active", &sched.id).exists());
        assert!(schedule_dir(r, "triggered", &sched.id).join(PROMPT_FILE).exists());
        let reloaded = get(r, &sched.id).await.unwrap().unwrap();
        assert_eq!(reloaded.state, State::Triggered);
        assert!(reloaded.last_run_at.is_some());
    }

    #[tokio::test]
    async fn fire_one_oneshot_missed_beyond_grace_notifies_and_consumes() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let at = now() + TimeDelta::seconds(3600);
        let sched = create(r, new_oneshot(Some("ping"), None, at), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let host = FakeHost::new();
        let late = sched.next_run_at + TimeDelta::seconds(3 * 3600);
        fire_one(&host, &cfg(), r, &sched, late).await.unwrap();
        {
            let calls = host.calls.lock();
            assert!(calls.fired.is_empty());
            assert!(matches!(calls.notified[0], HomeNotice::Missed { .. }));
        }
        assert_eq!(get(r, &sched.id).await.unwrap().unwrap().state, State::Triggered);
    }

    #[tokio::test]
    async fn fire_one_recurring_stale_skips_and_advances() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let sched = create(r, new_interval(Some("p"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let host = FakeHost::new();
        let stale = sched.next_run_at + TimeDelta::seconds(7200);
        fire_one(&host, &cfg(), r, &sched, stale).await.unwrap();
        assert!(host.calls.lock().fired.is_empty());
        let reloaded = get(r, &sched.id).await.unwrap().unwrap();
        assert!(reloaded.next_run_at > sched.next_run_at);
        assert_eq!(reloaded.state, State::Active);
    }

    #[tokio::test]
    async fn fire_one_transient_records_failure_and_disables_on_third() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let created = create(r, new_interval(Some("p"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let mut host = FakeHost::new();
        host.fire_outcome = FireOutcome::Transient;

        let mut sched = created.clone();
        for expected in 1..=2 {
            fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
            let reloaded = get(r, &sched.id).await.unwrap().unwrap();
            assert_eq!(reloaded.consecutive_failures, expected);
            assert_eq!(reloaded.state, State::Active);
            assert!(reloaded.next_run_at > sched.next_run_at);
            sched = reloaded;
        }
        fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
        let reloaded = get(r, &sched.id).await.unwrap().unwrap();
        assert_eq!(reloaded.consecutive_failures, 3);
        assert_eq!(reloaded.state, State::Disabled);
        let calls = host.calls.lock();
        assert_eq!(calls.fired.len(), 3);
        assert_eq!(calls.notified.len(), 1);
        assert!(matches!(
            calls.notified[0],
            HomeNotice::Disabled(DisableReason::ConsecutiveFailures(_))
        ));
    }

    #[tokio::test]
    async fn fire_one_oneshot_transient_retries_and_is_not_consumed() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let at = now() + TimeDelta::seconds(3600);
        let created = create(r, new_oneshot(Some("ping"), None, at), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let mut host = FakeHost::new();
        host.fire_outcome = FireOutcome::Transient;
        let mut sched = created.clone();
        for expected in 1..=2 {
            fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
            let reloaded = get(r, &sched.id).await.unwrap().unwrap();
            assert_eq!(reloaded.consecutive_failures, expected);
            assert_eq!(reloaded.state, State::Active);
            assert!(reloaded.next_run_at > sched.next_run_at);
            sched = reloaded;
        }
        fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
        assert_eq!(get(r, &sched.id).await.unwrap().unwrap().state, State::Disabled);
    }

    #[tokio::test]
    async fn fire_one_missing_definition_disables_and_notifies() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let sched = create(r, new_interval(Some("p"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        fs::remove_file(schedule_dir(r, "active", &sched.id).join(PROMPT_FILE)).unwrap();
        let host = FakeHost::new();
        fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
        {
            let calls = host.calls.lock();
            assert!(calls.fired.is_empty());
            assert_eq!(calls.notified[0], HomeNotice::Disabled(DisableReason::MissingDefinition));
        }
        assert_eq!(get(r, &sched.id).await.unwrap().unwrap().state, State::Disabled);
    }

    #[tokio::test]
    async fn fire_one_reads_edited_script_at_fire_time() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let sched = create(
            r,
            new_interval(None, Some("echo '{\"skip\":true}'"), 3600),
            Some(chrono_tz::UTC),
        )
        .await
        .unwrap();
        let script_path = schedule_dir(r, "active", &sched.id).join(SCRIPT_FILE);
        fs::write(&script_path, "echo '{\"skip\":false,\"context\":\"edited body\"}'").unwrap();
        let host = FakeHost::new();
        fire_one(&host, &cfg(), r, &sched, sched.next_run_at).await.unwrap();
        assert_eq!(host.calls.lock().posted, vec!["edited body".to_owned()]);
    }

    #[tokio::test]
    async fn run_boot_sweep_fires_due_schedule_then_advances() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path().to_path_buf();
        let sched = create(&r, new_interval(Some("tick"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let past = now() - TimeDelta::seconds(5);
        backdate(&r, &sched.id, past);

        let host = FakeHost::new();
        let calls = Arc::clone(&host.calls);
        let cancel = CancellationToken::new();
        let driver = {
            let cancel = cancel.clone();
            let root = r.clone();
            tokio::spawn(async move { run(host, cfg(), root, cancel).await })
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while calls.lock().fired.is_empty() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        cancel.cancel();
        driver.await.unwrap();

        assert_eq!(calls.lock().fired.len(), 1);
        let reloaded = get(&r, &sched.id).await.unwrap().unwrap();
        assert!(reloaded.next_run_at > past);
        assert_eq!(reloaded.state, State::Active);
    }

    #[tokio::test]
    async fn trigger_marks_active_and_makes_it_due_without_touching_next_run() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let created = create(r, new_interval(Some("p"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        assert!(created.next_run_at > now() + TimeDelta::seconds(60));
        assert_eq!(trigger(r, &created.id).await.unwrap(), TriggerOutcome::Triggered);
        assert!(has_trigger_marker(r, &created.id));
        assert_eq!(get(r, &created.id).await.unwrap().unwrap().next_run_at, created.next_run_at);
        let due_ids: Vec<String> = due(r, now()).await.unwrap().into_iter().map(|s| s.id).collect();
        assert!(due_ids.contains(&created.id));
    }

    #[tokio::test]
    async fn trigger_missing_id_is_not_found() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(trigger(root.path(), "nope").await.unwrap(), TriggerOutcome::NotFound);
    }

    #[tokio::test]
    async fn trigger_inactive_when_disabled_writes_no_marker() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let created = create(r, new_interval(Some("p"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        set_state(r, &created.id, State::Disabled).await.unwrap();
        assert_eq!(
            trigger(r, &created.id).await.unwrap(),
            TriggerOutcome::Inactive(State::Disabled)
        );
        assert!(!has_trigger_marker(r, &created.id));
    }

    #[tokio::test]
    async fn trigger_then_fire_one_consumes_oneshot_before_its_time() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let at = now() + TimeDelta::seconds(3600);
        let created = create(r, new_oneshot(Some("ping"), None, at), Some(chrono_tz::UTC))
            .await
            .unwrap();
        assert_eq!(trigger(r, &created.id).await.unwrap(), TriggerOutcome::Triggered);
        let reloaded = get(r, &created.id).await.unwrap().unwrap();
        fire_one(&FakeHost::new(), &cfg(), r, &reloaded, now()).await.unwrap();
        assert_eq!(get(r, &created.id).await.unwrap().unwrap().state, State::Triggered);
        assert!(!has_trigger_marker(r, &created.id));
    }

    #[tokio::test]
    async fn trigger_then_fire_one_recurring_keeps_next_run_and_records_last_run() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let created = create(r, new_interval(Some("p"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        let scheduled = created.next_run_at;
        assert_eq!(trigger(r, &created.id).await.unwrap(), TriggerOutcome::Triggered);
        let reloaded = get(r, &created.id).await.unwrap().unwrap();
        fire_one(&FakeHost::new(), &cfg(), r, &reloaded, now()).await.unwrap();
        let after = get(r, &created.id).await.unwrap().unwrap();
        assert_eq!(after.state, State::Active);
        assert_eq!(after.next_run_at, scheduled);
        assert!(after.last_run_at.is_some());
        assert!(!has_trigger_marker(r, &created.id));
    }

    #[tokio::test]
    async fn trigger_then_fire_one_recurring_already_due_advances_next_run() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        let created = create(r, new_interval(Some("p"), None, 3600), Some(chrono_tz::UTC))
            .await
            .unwrap();
        backdate(r, &created.id, now() - TimeDelta::seconds(120));
        assert_eq!(trigger(r, &created.id).await.unwrap(), TriggerOutcome::Triggered);
        let reloaded = get(r, &created.id).await.unwrap().unwrap();
        fire_one(&FakeHost::new(), &cfg(), r, &reloaded, now()).await.unwrap();
        let after = get(r, &created.id).await.unwrap().unwrap();
        assert_eq!(after.state, State::Active);
        assert!(after.next_run_at > now());
        assert!(!has_trigger_marker(r, &created.id));
    }
}
