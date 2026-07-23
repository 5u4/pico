import { Database } from "bun:sqlite";
import { Effect, Layer, Option, Schema, type Scope } from "effect";
import { ulid } from "ulid";
import { PicoConfig } from "../config/pico-config.ts";
import {
  ChatNotFound,
  DbError,
  DuplicateExternalId,
  SpaceNotFound,
} from "./errors.ts";
import { runMigrations } from "./migrations.ts";
import { normalizeCwd } from "./paths.ts";
import { Chat, type Platform, Space } from "./schema.ts";

export interface CreateSpaceInput {
  readonly defaultCwd: string;
  readonly platform: Space["platform"];
  readonly name: string;
  readonly externalId?: string;
  readonly checkoutBranch?: string;
  readonly branchPrefix?: string;
}

export interface CreateChatInput {
  readonly spaceId: string;
  readonly cwd: string;
  readonly title: string;
  readonly externalId?: string;
}

export interface StoreApi {
  readonly spaces: {
    readonly create: (
      input: CreateSpaceInput,
    ) => Effect.Effect<Space, DuplicateExternalId | DbError>;
    readonly get: (id: string) => Effect.Effect<Option.Option<Space>, DbError>;
    readonly list: (
      platforms: ReadonlyArray<Platform>,
    ) => Effect.Effect<ReadonlyArray<Space>, DbError>;
    readonly updateCwd: (
      id: string,
      cwd: string,
    ) => Effect.Effect<Space, SpaceNotFound | DbError>;
    readonly delete: (
      id: string,
    ) => Effect.Effect<void, SpaceNotFound | DbError>;
  };
  readonly chats: {
    readonly create: (
      input: CreateChatInput,
    ) => Effect.Effect<Chat, DuplicateExternalId | SpaceNotFound | DbError>;
    readonly get: (id: string) => Effect.Effect<Option.Option<Chat>, DbError>;
    readonly list: (
      spaceId: string,
    ) => Effect.Effect<ReadonlyArray<Chat>, DbError>;
    readonly archive: (
      id: string,
    ) => Effect.Effect<void, ChatNotFound | DbError>;
    readonly delete: (id: string) => Effect.Effect<void, DbError>;
  };
}

const sqliteCode = (cause: unknown): string | undefined =>
  cause !== null &&
  typeof cause === "object" &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeChat = Schema.decodeUnknownSync(Chat);

const make = (dbPath: string): Effect.Effect<StoreApi, never, Scope.Scope> =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const database = new Database(dbPath);
        database.run("PRAGMA journal_mode = WAL");
        database.run("PRAGMA foreign_keys = ON");
        database.run("PRAGMA busy_timeout = 5000");
        runMigrations(database);
        return database;
      }),
      (database) => Effect.sync(() => database.close()),
    );

    const spaces: StoreApi["spaces"] = {
      create: (input) =>
        Effect.try({
          try: () => {
            const id = ulid();
            const createdAt = Date.now();
            const name = input.name;
            const externalId = input.externalId ?? null;
            const checkoutBranch = input.checkoutBranch ?? null;
            const branchPrefix = input.branchPrefix ?? null;
            const row = db
              .query(
                `INSERT INTO spaces
                (id, defaultCwd, platform, name, externalId, checkoutBranch, branchPrefix, createdAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
              )
              .get(
                id,
                normalizeCwd(input.defaultCwd),
                input.platform,
                name,
                externalId,
                checkoutBranch,
                branchPrefix,
                createdAt,
              );
            return decodeSpace(row);
          },
          catch: (cause): DuplicateExternalId | DbError => {
            const code = sqliteCode(cause);
            if (
              code === "SQLITE_CONSTRAINT_UNIQUE" &&
              input.externalId !== undefined
            )
              return new DuplicateExternalId({ externalId: input.externalId });
            if (
              code === "SQLITE_CONSTRAINT_CHECK" ||
              code === "SQLITE_CONSTRAINT_NOTNULL"
            )
              throw cause;
            return new DbError({ op: "spaces.create", cause });
          },
        }),
      get: (id) =>
        Effect.try({
          try: () => {
            const row = db.query("SELECT * FROM spaces WHERE id = ?").get(id);
            return row === null ? Option.none() : Option.some(decodeSpace(row));
          },
          catch: (cause): DbError => new DbError({ op: "spaces.get", cause }),
        }),
      list: (platforms) =>
        Effect.try({
          try: () => {
            if (platforms.length === 0) return [];
            const placeholders = platforms.map(() => "?").join(", ");
            return db
              .query(
                `SELECT * FROM spaces WHERE platform IN (${placeholders}) ORDER BY createdAt`,
              )
              .all(...platforms)
              .map((row) => decodeSpace(row));
          },
          catch: (cause): DbError => new DbError({ op: "spaces.list", cause }),
        }),
      updateCwd: (id, cwd) =>
        Effect.try({
          try: () => {
            const row = db
              .query(
                "UPDATE spaces SET defaultCwd = ? WHERE id = ? RETURNING *",
              )
              .get(normalizeCwd(cwd), id);
            return row === null ? Option.none() : Option.some(decodeSpace(row));
          },
          catch: (cause): DbError =>
            new DbError({ op: "spaces.updateCwd", cause }),
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new SpaceNotFound({ spaceId: id })),
              onSome: (space) => Effect.succeed(space),
            }),
          ),
        ),
      delete: (id) =>
        Effect.try({
          try: () =>
            db.query("DELETE FROM spaces WHERE id = ?").run(id).changes,
          catch: (cause): DbError =>
            new DbError({ op: "spaces.delete", cause }),
        }).pipe(
          Effect.flatMap((changes) =>
            changes === 0
              ? Effect.fail(new SpaceNotFound({ spaceId: id }))
              : Effect.void,
          ),
        ),
    };

    const chats: StoreApi["chats"] = {
      create: (input) =>
        Effect.try({
          try: () => {
            const id = ulid();
            const createdAt = Date.now();
            const title = input.title;
            const externalId = input.externalId ?? null;
            const row = db
              .query(
                `INSERT INTO chats
                (id, spaceId, cwd, title, externalId, createdAt, archivedAt)
               VALUES (?, ?, ?, ?, ?, ?, NULL) RETURNING *`,
              )
              .get(
                id,
                input.spaceId,
                normalizeCwd(input.cwd),
                title,
                externalId,
                createdAt,
              );
            return decodeChat(row);
          },
          catch: (cause): DuplicateExternalId | SpaceNotFound | DbError => {
            const code = sqliteCode(cause);
            if (
              code === "SQLITE_CONSTRAINT_UNIQUE" &&
              input.externalId !== undefined
            )
              return new DuplicateExternalId({ externalId: input.externalId });
            if (code === "SQLITE_CONSTRAINT_FOREIGNKEY")
              return new SpaceNotFound({ spaceId: input.spaceId });
            if (
              code === "SQLITE_CONSTRAINT_CHECK" ||
              code === "SQLITE_CONSTRAINT_NOTNULL"
            )
              throw cause;
            return new DbError({ op: "chats.create", cause });
          },
        }),
      get: (id) =>
        Effect.try({
          try: () => {
            const row = db.query("SELECT * FROM chats WHERE id = ?").get(id);
            return row === null ? Option.none() : Option.some(decodeChat(row));
          },
          catch: (cause): DbError => new DbError({ op: "chats.get", cause }),
        }),
      list: (spaceId) =>
        Effect.try({
          try: () =>
            db
              .query(
                "SELECT * FROM chats WHERE spaceId = ? AND archivedAt IS NULL ORDER BY createdAt",
              )
              .all(spaceId)
              .map((row) => decodeChat(row)),
          catch: (cause): DbError => new DbError({ op: "chats.list", cause }),
        }),
      archive: (id) =>
        Effect.try({
          try: () =>
            db
              .query("UPDATE chats SET archivedAt = ? WHERE id = ?")
              .run(Date.now(), id).changes,
          catch: (cause): DbError =>
            new DbError({ op: "chats.archive", cause }),
        }).pipe(
          Effect.flatMap((changes) =>
            changes === 0
              ? Effect.fail(new ChatNotFound({ chatId: id }))
              : Effect.void,
          ),
        ),
      delete: (id) =>
        Effect.try({
          try: () => {
            db.query("DELETE FROM chats WHERE id = ?").run(id);
          },
          catch: (cause): DbError => new DbError({ op: "chats.delete", cause }),
        }),
    };

    return { spaces, chats };
  });

export class Store extends Effect.Service<Store>()("pico/Store", {
  dependencies: [PicoConfig.Default],
  scoped: Effect.gen(function* () {
    const config = yield* PicoConfig;
    return yield* make(config.dbPath);
  }),
}) {}

export const layerStore = (dbPath: string): Layer.Layer<Store> =>
  Layer.scoped(Store, make(dbPath).pipe(Effect.map(Store.make)));
