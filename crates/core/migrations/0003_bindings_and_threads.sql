CREATE TABLE bindings (
    platform       TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    profile        TEXT NOT NULL,
    kind           TEXT NOT NULL,
    cwd            TEXT,
    base_repo      TEXT,
    default_branch TEXT,
    PRIMARY KEY (platform, channel_id)
);

DROP TABLE threads;

CREATE TABLE threads (
    platform       TEXT NOT NULL,
    thread_id      TEXT NOT NULL,
    profile        TEXT NOT NULL,
    cwd            TEXT NOT NULL,
    base_repo      TEXT,
    default_branch TEXT,
    closed_at      TEXT,
    PRIMARY KEY (platform, thread_id)
);
