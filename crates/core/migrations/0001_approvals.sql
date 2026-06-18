CREATE TABLE approvals (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    detail       TEXT NOT NULL,
    status       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    guild_id     TEXT,
    message_id   TEXT,
    requested_by TEXT,
    resolved_at  TEXT,
    resolver     TEXT
);

CREATE INDEX approvals_status ON approvals (status);
