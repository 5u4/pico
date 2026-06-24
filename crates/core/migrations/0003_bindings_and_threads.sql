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

CREATE TABLE threads_new (
    platform       TEXT NOT NULL,
    thread_id      TEXT NOT NULL,
    profile        TEXT NOT NULL,
    cwd            TEXT NOT NULL,
    base_repo      TEXT,
    default_branch TEXT,
    closed_at      TEXT,
    PRIMARY KEY (platform, thread_id)
);

INSERT INTO threads_new (platform, thread_id, profile, cwd, base_repo, default_branch, closed_at)
    SELECT 'discord', thread_id, profile, cwd, base_repo, default_branch, closed_at FROM threads;

DROP TABLE threads;

ALTER TABLE threads_new RENAME TO threads;
