use std::path::Path;

use chrono::{DateTime, Utc};
use clap::Subcommand;
use color_eyre::eyre::eyre;
use pico_core::schedule::{self, Mode, NewSchedule, Schedule, State, Trigger};

#[derive(Subcommand)]
pub enum ScheduleCommand {
    Create {
        #[arg(long)]
        json: String,
    },
    List {
        #[arg(long)]
        scope: Option<String>,
        #[arg(long)]
        json: bool,
    },
    Show {
        id: String,
        #[arg(long)]
        scope: Option<String>,
        #[arg(long)]
        json: bool,
    },
    Remove {
        id: String,
        #[arg(long)]
        scope: Option<String>,
    },
    Enable {
        id: String,
        #[arg(long)]
        scope: Option<String>,
    },
    Disable {
        id: String,
        #[arg(long)]
        scope: Option<String>,
    },
    Trigger {
        id: String,
        #[arg(long)]
        scope: Option<String>,
    },
}

pub async fn run(cmd: ScheduleCommand) -> color_eyre::Result<()> {
    match cmd {
        ScheduleCommand::Create { json } => {
            create(&json).await;
            Ok(())
        }
        ScheduleCommand::List { scope, json } => list(scope, json).await,
        ScheduleCommand::Show { id, scope, json } => show(&id, scope, json).await,
        ScheduleCommand::Remove { id, scope } => remove(&id, scope).await,
        ScheduleCommand::Enable { id, scope } => apply_state(&id, scope, State::Active, "enabled").await,
        ScheduleCommand::Disable { id, scope } => apply_state(&id, scope, State::Disabled, "disabled").await,
        ScheduleCommand::Trigger { id, scope } => trigger(&id, scope).await,
    }
}

#[derive(serde::Deserialize)]
struct CreateInput {
    name: String,
    mode: ModeInput,
    trigger: TriggerInput,
    #[serde(default)]
    script: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    created_by: Option<String>,
    #[serde(default)]
    max_runs: Option<i64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum ModeInput {
    Continue,
    Fresh,
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TriggerInput {
    Oneshot {
        at: String,
    },
    Cron {
        expr: String,
        #[serde(default)]
        tz: Option<String>,
    },
}

async fn create(json: &str) {
    match build_and_create(json).await {
        Ok(value) => println!("{value}"),
        Err(msg) => {
            let report = serde_json::json!({ "error": msg });
            println!("{report}");
            std::process::exit(1);
        }
    }
}

async fn build_and_create(json: &str) -> Result<serde_json::Value, String> {
    let input: CreateInput = serde_json::from_str(json).map_err(|e| format!("invalid json: {e}"))?;
    let new = input.into_new_schedule()?;
    let root = pico_shared::paths::worker_root().map_err(|e| e.to_string())?;
    let tz = pico_core::config::load_root(&pico_shared::paths::worker_config(&root))
        .map_err(|e| e.to_string())?
        .schedule()
        .timezone;
    let sched = schedule::create(&root, new, tz).await.map_err(|e| e.to_string())?;
    schedule_dto(&sched, &root).await.map_err(|e| e.to_string())
}

impl CreateInput {
    fn into_new_schedule(self) -> Result<NewSchedule, String> {
        let platform = self
            .platform
            .or_else(|| env_var("PICO_PLATFORM"))
            .unwrap_or_else(|| "discord".to_string());
        let scope = resolve_context(self.scope, "PICO_GUILD_ID", "scope")?;
        let origin = resolve_context(self.origin, "PICO_THREAD_ID", "origin")?;
        let target = resolve_context(self.target, "PICO_CHANNEL_ID", "target")?;
        let created_by = resolve_context(self.created_by, "PICO_USER_ID", "created_by")?;
        let mode = match self.mode {
            ModeInput::Continue => Mode::Continue,
            ModeInput::Fresh => Mode::Fresh,
        };
        let trigger = self.trigger.into_trigger()?;
        Ok(NewSchedule {
            platform,
            scope,
            name: self.name,
            created_by,
            mode,
            origin,
            target,
            trigger,
            script: self.script,
            prompt: self.prompt,
            max_runs: self.max_runs,
        })
    }
}

impl TriggerInput {
    fn into_trigger(self) -> Result<Trigger, String> {
        match self {
            TriggerInput::Oneshot { at } => {
                let at = DateTime::parse_from_rfc3339(&at)
                    .map_err(|e| format!("invalid oneshot 'at' timestamp: {e}"))?
                    .with_timezone(&Utc);
                Ok(Trigger::Oneshot { at })
            }
            TriggerInput::Cron { expr, tz } => {
                let tz = match tz {
                    Some(name) => name
                        .parse::<chrono_tz::Tz>()
                        .map_err(|e| format!("invalid cron timezone: {e}"))?,
                    None => chrono_tz::UTC,
                };
                Ok(Trigger::Cron { expr, tz })
            }
        }
    }
}

fn resolve_context(value: Option<String>, env_key: &str, field: &str) -> Result<String, String> {
    value
        .or_else(|| env_var(env_key))
        .ok_or_else(|| format!("missing {field}: provide it in the json or set {env_key}"))
}

fn env_var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

async fn list(scope: Option<String>, json: bool) -> color_eyre::Result<()> {
    let scope = scope
        .or_else(|| env_var("PICO_GUILD_ID"))
        .ok_or_else(|| eyre!("missing scope: pass --scope or set PICO_GUILD_ID"))?;
    let root = pico_shared::paths::worker_root()?;
    let schedules = schedule::list(&root, "discord", &scope).await?;
    if json {
        let mut dtos = Vec::with_capacity(schedules.len());
        for sched in &schedules {
            dtos.push(schedule_dto(sched, &root).await?);
        }
        println!("{}", serde_json::Value::Array(dtos));
    } else if schedules.is_empty() {
        println!("no schedules");
    } else {
        for sched in &schedules {
            println!(
                "{}  {}  [{}]  {}  next {}",
                sched.id,
                sched.name,
                state_str(sched.state),
                sched.trigger.describe(),
                sched.next_run_at.to_rfc3339()
            );
        }
    }
    Ok(())
}

async fn show(id: &str, scope: Option<String>, json: bool) -> color_eyre::Result<()> {
    let root = pico_shared::paths::worker_root()?;
    let sched = scoped(schedule::get(&root, id).await?, caller_scope(scope).as_deref())
        .ok_or_else(|| eyre!("no schedule with id {id}"))?;
    if json {
        println!("{}", schedule_dto(&sched, &root).await?);
    } else {
        print_human(&sched, &root).await?;
    }
    Ok(())
}

async fn remove(id: &str, scope: Option<String>) -> color_eyre::Result<()> {
    let root = pico_shared::paths::worker_root()?;
    if scoped(schedule::get(&root, id).await?, caller_scope(scope).as_deref()).is_none() {
        return Err(eyre!("no schedule with id {id}"));
    }
    schedule::remove(&root, id).await?;
    println!("removed schedule {id}");
    Ok(())
}

async fn trigger(id: &str, scope: Option<String>) -> color_eyre::Result<()> {
    let root = pico_shared::paths::worker_root()?;
    if scoped(schedule::get(&root, id).await?, caller_scope(scope).as_deref()).is_none() {
        return Err(eyre!("no schedule with id {id}"));
    }
    match schedule::trigger(&root, id).await? {
        schedule::TriggerOutcome::Triggered => {
            println!("triggered schedule {id}");
            Ok(())
        }
        schedule::TriggerOutcome::NotFound => Err(eyre!("no schedule with id {id}")),
        schedule::TriggerOutcome::Inactive(state) => {
            Err(eyre!("schedule {id} is {}; enable it before triggering", state_str(state)))
        }
    }
}

async fn apply_state(id: &str, scope: Option<String>, state: State, label: &str) -> color_eyre::Result<()> {
    let root = pico_shared::paths::worker_root()?;
    if scoped(schedule::get(&root, id).await?, caller_scope(scope).as_deref()).is_none() {
        return Err(eyre!("no schedule with id {id}"));
    }
    schedule::set_state(&root, id, state).await?;
    println!("{label} schedule {id}");
    Ok(())
}

fn caller_scope(scope: Option<String>) -> Option<String> {
    scope.or_else(|| env_var("PICO_GUILD_ID"))
}

fn scoped(sched: Option<Schedule>, scope: Option<&str>) -> Option<Schedule> {
    match (sched, scope) {
        (Some(sched), Some(scope)) if sched.scope != scope => None,
        (sched, _) => sched,
    }
}

async fn print_human(sched: &Schedule, root: &Path) -> color_eyre::Result<()> {
    println!("id          {}", sched.id);
    println!("name        {}", sched.name);
    println!("state       {}", state_str(sched.state));
    println!("mode        {}", mode_str(sched.mode));
    println!("trigger     {}", sched.trigger.describe());
    println!("next_run_at {}", sched.next_run_at.to_rfc3339());
    println!("platform    {}", sched.platform);
    println!("scope       {}", sched.scope);
    println!("origin      {}", sched.origin);
    println!("target      {}", sched.target);
    println!("created_by  {}", sched.created_by);
    println!("created_at  {}", sched.created_at.to_rfc3339());
    if let Some(last) = sched.last_run_at {
        println!("last_run_at {}", last.to_rfc3339());
    }
    println!("failures    {}", sched.consecutive_failures);
    match sched.max_runs {
        Some(max_runs) => println!("runs        {} / {}", sched.run_count, max_runs),
        None => println!("runs        {}", sched.run_count),
    }
    let def = schedule::read_definition(root, &sched.id).await?;
    println!("script_path {}", def.script_path.display());
    println!("prompt_path {}", def.prompt_path.display());
    if let Some(script) = &def.script {
        println!("script      {script}");
    }
    if let Some(prompt) = &def.prompt {
        println!("prompt      {prompt}");
    }
    Ok(())
}

async fn schedule_dto(sched: &Schedule, root: &Path) -> color_eyre::Result<serde_json::Value> {
    let def = schedule::read_definition(root, &sched.id).await?;
    Ok(serde_json::json!({
        "id": sched.id,
        "platform": sched.platform,
        "scope": sched.scope,
        "name": sched.name,
        "created_by": sched.created_by,
        "created_at": sched.created_at.to_rfc3339(),
        "mode": mode_str(sched.mode),
        "origin": sched.origin,
        "target": sched.target,
        "trigger": trigger_dto(&sched.trigger),
        "script": def.script,
        "prompt": def.prompt,
        "script_path": def.script_path.display().to_string(),
        "prompt_path": def.prompt_path.display().to_string(),
        "next_run_at": sched.next_run_at.to_rfc3339(),
        "last_run_at": sched.last_run_at.map(|d| d.to_rfc3339()),
        "consecutive_failures": sched.consecutive_failures,
        "max_runs": sched.max_runs,
        "run_count": sched.run_count,
        "state": state_str(sched.state),
    }))
}

fn trigger_dto(trigger: &Trigger) -> serde_json::Value {
    match trigger {
        Trigger::Oneshot { at } => serde_json::json!({ "kind": "oneshot", "at": at.to_rfc3339() }),
        Trigger::Cron { expr, tz } => {
            serde_json::json!({ "kind": "cron", "expr": expr, "tz": tz.name() })
        }
    }
}

fn mode_str(mode: Mode) -> &'static str {
    match mode {
        Mode::Continue => "continue",
        Mode::Fresh => "fresh",
    }
}

fn state_str(state: State) -> &'static str {
    match state {
        State::Active => "active",
        State::Disabled => "disabled",
        State::Triggered => "triggered",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_oneshot_input() {
        let json = r#"{"name":"remind","mode":"continue","trigger":{"kind":"oneshot","at":"2030-01-01T00:00:00Z"},"prompt":"ping"}"#;
        let input: CreateInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.name, "remind");
        assert!(matches!(input.mode, ModeInput::Continue));
        assert_eq!(input.prompt.as_deref(), Some("ping"));
        match input.trigger.into_trigger().unwrap() {
            Trigger::Oneshot { at } => assert_eq!(at.to_rfc3339(), "2030-01-01T00:00:00+00:00"),
            other => panic!("expected oneshot, got {other:?}"),
        }
    }

    #[test]
    fn parses_cron_input_defaulting_tz_to_utc() {
        let json =
            r#"{"name":"digest","mode":"fresh","trigger":{"kind":"cron","expr":"0 9 * * MON"},"script":"echo hi"}"#;
        let input: CreateInput = serde_json::from_str(json).unwrap();
        assert!(matches!(input.mode, ModeInput::Fresh));
        match input.trigger.into_trigger().unwrap() {
            Trigger::Cron { expr, tz } => {
                assert_eq!(expr, "0 9 * * MON");
                assert_eq!(tz, chrono_tz::UTC);
            }
            other => panic!("expected cron, got {other:?}"),
        }
    }

    #[test]
    fn parses_cron_input_with_explicit_tz() {
        let trigger = TriggerInput::Cron {
            expr: "0 9 * * *".to_string(),
            tz: Some("America/Vancouver".to_string()),
        };
        match trigger.into_trigger().unwrap() {
            Trigger::Cron { tz, .. } => assert_eq!(tz, chrono_tz::America::Vancouver),
            other => panic!("expected cron, got {other:?}"),
        }
    }

    #[test]
    fn rejects_unparsable_oneshot_timestamp() {
        let trigger = TriggerInput::Oneshot {
            at: "not-a-time".to_string(),
        };
        assert!(trigger.into_trigger().is_err());
    }

    #[test]
    fn rejects_unknown_cron_timezone() {
        let trigger = TriggerInput::Cron {
            expr: "0 9 * * *".to_string(),
            tz: Some("Mars/Phobos".to_string()),
        };
        assert!(trigger.into_trigger().is_err());
    }

    #[test]
    fn trigger_dto_round_trips_kinds() {
        let oneshot = trigger_dto(&Trigger::Oneshot {
            at: DateTime::parse_from_rfc3339("2030-01-01T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        });
        assert_eq!(oneshot["kind"], "oneshot");
        let cron = trigger_dto(&Trigger::Cron {
            expr: "0 9 * * MON".to_string(),
            tz: chrono_tz::America::Vancouver,
        });
        assert_eq!(cron["kind"], "cron");
        assert_eq!(cron["tz"], "America/Vancouver");
    }

    fn sample_schedule(scope: &str) -> Schedule {
        Schedule {
            id: "01".to_owned(),
            platform: "discord".to_owned(),
            scope: scope.to_owned(),
            name: "n".to_owned(),
            created_by: "u".to_owned(),
            created_at: Utc::now(),
            mode: Mode::Fresh,
            origin: "o".to_owned(),
            target: "t".to_owned(),
            trigger: Trigger::Cron {
                expr: "0 * * * *".to_owned(),
                tz: chrono_tz::UTC,
            },
            next_run_at: Utc::now(),
            last_run_at: None,
            consecutive_failures: 0,
            max_runs: None,
            run_count: 0,
            state: State::Active,
        }
    }

    #[test]
    fn scoped_blocks_foreign_guild_but_allows_unscoped() {
        let sched = sample_schedule("guild-1");
        assert!(scoped(Some(sched.clone()), Some("guild-1")).is_some());
        assert!(scoped(Some(sched.clone()), Some("guild-2")).is_none());
        assert!(scoped(Some(sched.clone()), None).is_some());
        assert!(scoped(None, Some("guild-1")).is_none());
    }
}
