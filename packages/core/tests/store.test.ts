import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { runMigrations } from "../src/store/migrations.ts";
import { layerStore, Store } from "../src/store/store.ts";

const run = <A, E>(program: Effect.Effect<A, E, Store>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(layerStore(":memory:"))));

const runExit = <A, E>(program: Effect.Effect<A, E, Store>) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(layerStore(":memory:"))));

const readUserVersion = (db: Database): number => {
  const row = db.query("PRAGMA user_version").get();
  return row !== null &&
    typeof row === "object" &&
    "user_version" in row &&
    typeof row.user_version === "number"
    ? row.user_version
    : -1;
};

const tableNames = (db: Database): ReadonlyArray<string> =>
  db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .flatMap((row) =>
      row !== null &&
      typeof row === "object" &&
      "name" in row &&
      typeof row.name === "string"
        ? [row.name]
        : [],
    );

const webSpace = (name: string) =>
  Effect.flatMap(Store, (store) =>
    store.spaces.create({ defaultCwd: "/tmp/work", platform: "web", name }),
  );

describe("migrations", () => {
  it("brings a fresh db to the latest user_version with both tables", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(readUserVersion(db)).toBe(1);
    const tables = tableNames(db);
    expect(tables).toContain("spaces");
    expect(tables).toContain("chats");
    db.close();
  });

  it("is idempotent across repeated runs", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    runMigrations(db);
    expect(readUserVersion(db)).toBe(1);
    db.close();
  });

  it("cascades chat deletion when the parent space is removed", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db);
    db.query(
      "INSERT INTO spaces (id, defaultCwd, platform, name, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).run("s1", "/tmp/work", "web", "space", Date.now());
    db.query(
      "INSERT INTO chats (id, spaceId, cwd, title, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).run("c1", "s1", "/tmp/work", "chat", Date.now());
    db.query("DELETE FROM spaces WHERE id = ?").run("s1");
    const remaining = db.query("SELECT id FROM chats WHERE id = ?").get("c1");
    expect(remaining).toBeNull();
    db.close();
  });
});

describe("spaces", () => {
  it("creates and reads back a space with a non-empty ulid id", async () => {
    const found = await run(
      Effect.gen(function* () {
        const created = yield* webSpace("hello");
        expect(created.id.length).toBeGreaterThan(0);
        expect(created.platform).toBe("web");
        expect(created.name).toBe("hello");
        const store = yield* Store;
        return yield* store.spaces.get(created.id);
      }),
    );
    expect(Option.isSome(found)).toBe(true);
  });

  it("returns None for a missing space", async () => {
    const found = await run(
      Effect.flatMap(Store, (store) => store.spaces.get("missing")),
    );
    expect(Option.isNone(found)).toBe(true);
  });

  it("rejects a duplicate (platform, externalId) with DuplicateExternalId", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.spaces.create({
          defaultCwd: "/tmp/work",
          platform: "discord",
          name: "guild",
          externalId: "guild-1",
        });
        return yield* store.spaces.create({
          defaultCwd: "/tmp/work",
          platform: "discord",
          name: "guild",
          externalId: "guild-1",
        });
      }).pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left")
      expect(result.left._tag).toBe("DuplicateExternalId");
  });

  it("allows multiple web spaces with null externalId", async () => {
    const count = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* webSpace("one");
        yield* webSpace("two");
        const all = yield* store.spaces.list(["web"]);
        return all.length;
      }),
    );
    expect(count).toBe(2);
  });

  it("dies on a CHECK violation (empty defaultCwd)", async () => {
    const exit = await runExit(
      Effect.flatMap(Store, (store) =>
        store.spaces.create({ defaultCwd: "", platform: "web", name: "n" }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isDie(exit.cause)).toBe(true);
  });

  it("dies when checkoutBranch and branchPrefix are not paired", async () => {
    const exit = await runExit(
      Effect.flatMap(Store, (store) =>
        store.spaces.create({
          defaultCwd: "/tmp/work",
          platform: "web",
          checkoutBranch: "main",
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isDie(exit.cause)).toBe(true);
  });

  it("dies on an empty name (required)", async () => {
    const exit = await runExit(
      Effect.flatMap(Store, (store) =>
        store.spaces.create({
          defaultCwd: "/tmp/work",
          platform: "web",
          name: "",
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isDie(exit.cause)).toBe(true);
  });
});

describe("chats", () => {
  it("creates a chat under a space and reads it back", async () => {
    const found = await run(
      Effect.gen(function* () {
        const space = yield* webSpace("s");
        const store = yield* Store;
        const chat = yield* store.chats.create({
          spaceId: space.id,
          cwd: "/tmp/work",
          title: "first",
        });
        return yield* store.chats.get(chat.id);
      }),
    );
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) {
      expect(found.value.title).toBe("first");
      expect(Option.isNone(found.value.archivedAt)).toBe(true);
    }
  });

  it("returns None for a missing chat", async () => {
    const found = await run(
      Effect.flatMap(Store, (store) => store.chats.get("missing")),
    );
    expect(Option.isNone(found)).toBe(true);
  });

  it("fails with SpaceNotFound when spaceId does not exist (foreign_keys enforced)", async () => {
    const result = await run(
      Effect.flatMap(Store, (store) =>
        store.chats.create({ spaceId: "ghost", cwd: "/tmp/work", title: "t" }),
      ).pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left._tag).toBe("SpaceNotFound");
  });

  it("lists only chats within a space and empty for none", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const a = yield* webSpace("a");
        const b = yield* webSpace("b");
        yield* store.chats.create({
          spaceId: a.id,
          cwd: "/tmp/work",
          title: "one",
        });
        yield* store.chats.create({
          spaceId: a.id,
          cwd: "/tmp/work",
          title: "two",
        });
        const listA = yield* store.chats.list(a.id);
        const listB = yield* store.chats.list(b.id);
        return { a: listA.length, b: listB.length };
      }),
    );
    expect(result.a).toBe(2);
    expect(result.b).toBe(0);
  });

  it("archives a chat, stamping archivedAt", async () => {
    const found = await run(
      Effect.gen(function* () {
        const space = yield* webSpace("s");
        const store = yield* Store;
        const chat = yield* store.chats.create({
          spaceId: space.id,
          cwd: "/tmp/work",
          title: "arch",
        });
        yield* store.chats.archive(chat.id);
        return yield* store.chats.get(chat.id);
      }),
    );
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found))
      expect(Option.isSome(found.value.archivedAt)).toBe(true);
  });

  it("fails archive with ChatNotFound for a missing chat", async () => {
    const result = await run(
      Effect.flatMap(Store, (store) => store.chats.archive("missing")).pipe(
        Effect.either,
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left._tag).toBe("ChatNotFound");
  });

  it("dies on an empty title (required)", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const space = yield* webSpace("s");
        const store = yield* Store;
        return yield* store.chats.create({
          spaceId: space.id,
          cwd: "/tmp/work",
          title: "",
        });
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isDie(exit.cause)).toBe(true);
  });
});
