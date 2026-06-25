CREATE TABLE schedules (
    id                   TEXT PRIMARY KEY,
    platform             TEXT NOT NULL,
    scope                TEXT NOT NULL,
    name                 TEXT NOT NULL,
    created_by           TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    mode                 TEXT NOT NULL,
    origin               TEXT NOT NULL,
    target               TEXT NOT NULL,
    trigger_kind         TEXT NOT NULL,
    cron_expr            TEXT,
    tz                   TEXT,
    interval_secs        INTEGER,
    script               TEXT,
    prompt               TEXT,
    next_run_at          TEXT NOT NULL,
    last_run_at          TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    state                TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX schedules_due ON schedules (state, next_run_at);
