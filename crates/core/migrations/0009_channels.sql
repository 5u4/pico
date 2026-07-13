CREATE TABLE channels (
    platform   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    label      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (platform, channel_id)
);
