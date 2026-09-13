import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as Bot from "@pico/contract/bot-session";
import { ChatId } from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { PersistenceError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import { WorkspaceId } from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { layer } from "./layer.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000001");
const regularChatId = ChatId.make("018f47a0-0000-7000-8000-000000000002");
const workspaceId = WorkspaceId.make("018f47a0-0000-7000-8000-000000000003");
const handoffContent = "Continue the import in work/input.csv. Keep the existing column names.\n";

const makeFixture = Effect.fn("BotSessionsTest.makeFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-bot-persistence-" });
  const storeFile = AbsolutePath.make(path.join(root, "store.db"));
  const botRoot = AbsolutePath.make(path.join(root, "bot"));
  const cwd = AbsolutePath.make(path.join(botRoot, "work"));
  const journals = path.join(botRoot, "sessions");
  yield* fileSystem.makeDirectory(cwd, { recursive: true });
  yield* fileSystem.makeDirectory(journals, { recursive: true });
  const sourceJournal: Bot.SessionJournal = {
    id: Bot.PhysicalSessionId.make("source-journal"),
    file: AbsolutePath.make(path.join(journals, "source.jsonl")),
  };
  const nextJournal: Bot.SessionJournal = {
    id: Bot.PhysicalSessionId.make("next-journal"),
    file: AbsolutePath.make(path.join(journals, "next.jsonl")),
  };
  const laterJournal: Bot.SessionJournal = {
    id: Bot.PhysicalSessionId.make("later-journal"),
    file: AbsolutePath.make(path.join(journals, "later.jsonl")),
  };
  yield* fileSystem.writeFileString(sourceJournal.file, "retained source journal\n");
  yield* fileSystem.writeFileString(nextJournal.file, "next journal\n");
  yield* fileSystem.writeFileString(laterJournal.file, "later journal\n");
  const workFile = path.join(cwd, "input.csv");
  yield* fileSystem.writeFileString(workFile, "name,count\nretained,1\n");

  const seeded = yield* Effect.gen(function* () {
    const chats = yield* ChatRepository;
    const sessions = yield* Bot.BotSessions;
    const chat = yield* sessions.createConversation({
      botRoot,
      platform: null,
      chatId,
      workspaceId,
      cwd,
      createdAt: 2,
      journal: sourceJournal,
    });
    const regularChat = yield* chats.create({
      id: regularChatId,
      workspaceId,
      cwd,
      externalId: null,
      createdAt: 3,
    });
    yield* sessions.setTurn(chatId, sourceJournal.id, { kind: "pending" });
    yield* sessions.setTurn(chatId, sourceJournal.id, { kind: "completed", at: 10 });
    return {
      source: Option.getOrThrow(yield* sessions.findByChat(chatId)),
      chat,
      regularChat,
    };
  }).pipe(Effect.provide(layer(storeFile)), Effect.scoped);

  return { fileSystem, path, storeFile, nextJournal, laterJournal, workFile, ...seeded };
});

describe("BotSessions persistence", () => {
  it.effect("reopens the rotated journal and only its handoff without changing chats or work", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const { source, fileSystem, path } = fixture;
      const expectedHandoff = AbsolutePath.make(
        path.join(source.botRoot, "handoffs", `${source.journal.id}.md`),
      );
      const active = yield* Effect.gen(function* () {
        const sessions = yield* Bot.BotSessions;
        const handoff = yield* sessions.saveHandoff(source, handoffContent);
        assert.strictEqual(handoff, expectedHandoff);
        assert.strictEqual((yield* fileSystem.stat(handoff)).mode & 0o777, 0o600);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* sessions.findByRoot(source.botRoot)),
          source,
        );
        yield* sessions.rotate(source, fixture.nextJournal, handoff);
        const current = Option.getOrThrow(yield* sessions.findByChat(chatId));
        assert.deepStrictEqual(current, {
          ...source,
          journal: fixture.nextJournal,
          handoff,
          turn: { kind: "fresh" },
        });
        return current;
      }).pipe(Effect.provide(layer(fixture.storeFile)), Effect.scoped);

      yield* fileSystem.writeFileString(
        path.join(source.botRoot, "handoffs", "unrelated.md"),
        "Ignore this.",
      );
      yield* Effect.gen(function* () {
        const sessions = yield* Bot.BotSessions;
        const chats = yield* ChatRepository;
        assert.deepStrictEqual(
          Option.getOrThrow(yield* sessions.findByRoot(source.botRoot)),
          active,
        );
        assert.deepStrictEqual(Option.getOrThrow(yield* sessions.findByChat(chatId)), active);
        assert.strictEqual(yield* sessions.readHandoff(active), handoffContent);
        assert.deepStrictEqual(Option.getOrThrow(yield* chats.findById(chatId)), fixture.chat);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* chats.findById(regularChatId)),
          fixture.regularChat,
        );
        assert.isTrue(Option.isNone(yield* sessions.findByChat(regularChatId)));
      }).pipe(Effect.provide(layer(fixture.storeFile)), Effect.scoped);
      assert.strictEqual(
        yield* fileSystem.readFileString(source.journal.file),
        "retained source journal\n",
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(fixture.workFile),
        "name,count\nretained,1\n",
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "rejects pending and stale cutovers and turn writes without replacing the active pointer",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const { source } = fixture;
        yield* Effect.gen(function* () {
          const sessions = yield* Bot.BotSessions;
          const handoff = yield* sessions.saveHandoff(source, handoffContent);
          yield* sessions.setTurn(chatId, source.journal.id, { kind: "pending" });
          assert.instanceOf(
            yield* Effect.flip(sessions.rotate(source, fixture.nextJournal, handoff)),
            PersistenceError,
          );
          const pending = Option.getOrThrow(yield* sessions.findByChat(chatId));
          assert.deepStrictEqual(pending, { ...source, turn: { kind: "pending" } });
          assert.instanceOf(
            yield* Effect.flip(sessions.rotate(pending, fixture.nextJournal, handoff)),
            PersistenceError,
          );
          yield* sessions.setTurn(chatId, source.journal.id, { kind: "completed", at: 20 });
          assert.instanceOf(
            yield* Effect.flip(sessions.rotate(source, fixture.nextJournal, handoff)),
            PersistenceError,
          );
          const completed = Option.getOrThrow(yield* sessions.findByChat(chatId));
          const currentHandoff = "The later turn finished. Continue with work/output.csv.\n";
          yield* sessions.saveHandoff(completed, currentHandoff);
          yield* sessions.rotate(completed, fixture.nextJournal, handoff);
          const active = Option.getOrThrow(yield* sessions.findByChat(chatId));
          assert.instanceOf(
            yield* Effect.flip(
              sessions.setTurn(chatId, source.journal.id, { kind: "completed", at: 30 }),
            ),
            PersistenceError,
          );
          assert.instanceOf(
            yield* Effect.flip(sessions.rotate(completed, fixture.laterJournal, handoff)),
            PersistenceError,
          );
          assert.instanceOf(
            yield* Effect.flip(sessions.saveHandoff(completed, "Stale overwrite.")),
            PersistenceError,
          );
          assert.deepStrictEqual(Option.getOrThrow(yield* sessions.findByChat(chatId)), active);
          assert.strictEqual(yield* sessions.readHandoff(active), currentHandoff);
        }).pipe(Effect.provide(layer(fixture.storeFile)), Effect.scoped);
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("admits only one concurrent cutover from a completed source", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        const sessions = yield* Bot.BotSessions;
        const handoff = yield* sessions.saveHandoff(fixture.source, handoffContent);
        const [next, later] = yield* Effect.all(
          [
            Effect.result(sessions.rotate(fixture.source, fixture.nextJournal, handoff)),
            Effect.result(sessions.rotate(fixture.source, fixture.laterJournal, handoff)),
          ],
          { concurrency: "unbounded" },
        );
        assert.notStrictEqual(Result.isSuccess(next), Result.isSuccess(later));
        const active = Option.getOrThrow(yield* sessions.findByChat(chatId));
        assert.deepStrictEqual(
          active.journal,
          Result.isSuccess(next) ? fixture.nextJournal : fixture.laterJournal,
        );
        assert.deepStrictEqual(active.turn, { kind: "fresh" });
      }).pipe(Effect.provide(layer(fixture.storeFile)), Effect.scoped);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "reports a missing referenced handoff after restart instead of loading another file",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const active = yield* Effect.gen(function* () {
          const sessions = yield* Bot.BotSessions;
          const handoff = yield* sessions.saveHandoff(fixture.source, handoffContent);
          yield* sessions.rotate(fixture.source, fixture.nextJournal, handoff);
          yield* fixture.fileSystem.remove(handoff);
          yield* fixture.fileSystem.writeFileString(
            fixture.path.join(fixture.source.botRoot, "handoffs", "other.md"),
            "An unrelated handoff must not be used.",
          );
          return Option.getOrThrow(yield* sessions.findByChat(chatId));
        }).pipe(Effect.provide(layer(fixture.storeFile)), Effect.scoped);
        yield* Effect.gen(function* () {
          const sessions = yield* Bot.BotSessions;
          const reopened = Option.getOrThrow(yield* sessions.findByChat(chatId));
          assert.deepStrictEqual(reopened, active);
          assert.instanceOf(yield* Effect.flip(sessions.readHandoff(reopened)), PersistenceError);
          assert.deepStrictEqual(Option.getOrThrow(yield* sessions.findByChat(chatId)), active);
        }).pipe(Effect.provide(layer(fixture.storeFile)), Effect.scoped);
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "keeps the source pointer when handoff validation, file publication, or cutover preparation fails",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const { source, fileSystem, path } = fixture;
        yield* Effect.gen(function* () {
          const sessions = yield* Bot.BotSessions;
          assert.instanceOf(
            yield* Effect.flip(sessions.saveHandoff(source, " \n\t")),
            PersistenceError,
          );
          assert.instanceOf(
            yield* Effect.flip(sessions.saveHandoff(source, "é".repeat(8193))),
            PersistenceError,
          );
          const destination = path.join(source.botRoot, "handoffs", `${source.journal.id}.md`);
          yield* fileSystem.makeDirectory(destination, { recursive: true });
          assert.instanceOf(
            yield* Effect.flip(sessions.saveHandoff(source, handoffContent)),
            PersistenceError,
          );
          assert.deepStrictEqual(Option.getOrThrow(yield* sessions.findByChat(chatId)), source);
          yield* fileSystem.remove(destination, { recursive: true });
          const bounded = "é".repeat(8192);
          const handoff = yield* sessions.saveHandoff(source, bounded);
          assert.strictEqual(yield* fileSystem.readFileString(handoff), bounded);
          yield* fileSystem.remove(handoff);
          assert.instanceOf(
            yield* Effect.flip(sessions.rotate(source, fixture.nextJournal, handoff)),
            PersistenceError,
          );
          yield* sessions.saveHandoff(source, handoffContent);
          yield* fileSystem.remove(fixture.nextJournal.file);
          assert.instanceOf(
            yield* Effect.flip(sessions.rotate(source, fixture.nextJournal, handoff)),
            PersistenceError,
          );
          assert.deepStrictEqual(Option.getOrThrow(yield* sessions.findByChat(chatId)), source);
        }).pipe(Effect.provide(layer(fixture.storeFile)), Effect.scoped);
        yield* Effect.gen(function* () {
          const sessions = yield* Bot.BotSessions;
          assert.deepStrictEqual(Option.getOrThrow(yield* sessions.findByChat(chatId)), source);
        }).pipe(Effect.provide(layer(fixture.storeFile)), Effect.scoped);
      }).pipe(Effect.provide(platformLayer)),
  );
});
