CREATE TABLE threads (
    thread_id      TEXT PRIMARY KEY,
    profile        TEXT NOT NULL,
    cwd            TEXT NOT NULL,
    base_repo      TEXT,
    default_branch TEXT,
    closed_at      TEXT
);
