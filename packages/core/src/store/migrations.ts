import type { Database } from "bun:sqlite";

export type Migration = string | ((db: Database) => void);

export const migrations: ReadonlyArray<Migration> = [
  `
  CREATE TABLE spaces (
    id             TEXT PRIMARY KEY CHECK (length(id) > 0),
    defaultCwd     TEXT NOT NULL CHECK (length(defaultCwd) > 0),
    platform       TEXT NOT NULL,
    name           TEXT NOT NULL CHECK (length(name) > 0),
    externalId     TEXT,
    checkoutBranch TEXT,
    branchPrefix   TEXT,
    createdAt      INTEGER NOT NULL CHECK (createdAt >= 0),
    CHECK ((checkoutBranch IS NULL) = (branchPrefix IS NULL))
  );

  CREATE UNIQUE INDEX spaces_platform_external
    ON spaces (platform, externalId)
    WHERE externalId IS NOT NULL;

  CREATE TABLE chats (
    id          TEXT PRIMARY KEY CHECK (length(id) > 0),
    spaceId     TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    cwd         TEXT NOT NULL CHECK (length(cwd) > 0),
    title       TEXT NOT NULL CHECK (length(title) > 0),
    externalId  TEXT,
    createdAt   INTEGER NOT NULL CHECK (createdAt >= 0),
    archivedAt  INTEGER CHECK (archivedAt IS NULL OR archivedAt >= 0)
  );

  CREATE UNIQUE INDEX chats_space_external
    ON chats (spaceId, externalId)
    WHERE externalId IS NOT NULL;
  `,
];

export const runMigrations = (db: Database): void => {
  const row = db.query("PRAGMA user_version").get();
  const current =
    row !== null &&
    typeof row === "object" &&
    "user_version" in row &&
    typeof row.user_version === "number"
      ? row.user_version
      : 0;
  for (let version = current; version < migrations.length; version++) {
    const migration = migrations[version];
    if (migration === undefined) continue;
    const apply = db.transaction(() => {
      if (typeof migration === "string") db.run(migration);
      else migration(db);
      db.run(`PRAGMA user_version = ${version + 1}`);
    });
    apply();
  }
};
