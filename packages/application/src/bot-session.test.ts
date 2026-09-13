import { Database } from "bun:sqlite";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type { AgentEvent } from "@pico/contract/agent-event";
import { AgentPrompt } from "@pico/contract/agent-message";
import { AgentRuntime, type AgentTurnResult } from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import { type BotSession, BotSessions } from "@pico/contract/bot-session";
import { ChatId } from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AgentError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { GitWorktree } from "@pico/contract/worktree";
import * as SessionStore from "@pico/omp/agent-session-store";
import * as Persistence from "@pico/persistence/layer";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { BOT_JOURNAL_MAX_BYTES, BOT_SESSION_IDLE_MS, layer } from "./application.ts";

const platform = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);
const prompt = (text: string) => AgentPrompt.make({ text, attachments: [] });
const git: GitWorktree = {
  validate: () => Effect.die("bot must not use git"),
  create: () => Effect.die("bot must not create a worktree"),
  inspectChat: () => Effect.die("bot must not inspect a worktree"),
  renameChatBranch: () => Effect.die("bot must not rename a branch"),
  removeChat: () => Effect.die("bot must not remove a worktree"),
};

interface ModelBoundary {
  handoffFailure: boolean;
  outcome: AgentTurnResult["outcome"];
  readonly opened: Array<{
    readonly bot: BotSession;
    readonly handoff: string;
    readonly text: string;
  }>;
}

const fixture = (
  root: string,
  model: ModelBoundary,
  options: {
    readonly afterCutover?: Effect.Effect<void>;
    readonly afterCreatePhysical?: Effect.Effect<void>;
  } = {},
) => {
  const { afterCutover, afterCreatePhysical } = options;
  const basePersistence = Persistence.layer(AbsolutePath.make(`${root}/store.db`));
  const persistence =
    afterCutover === undefined
      ? basePersistence
      : Layer.effect(
          BotSessions,
          Effect.gen(function* () {
            const bots = yield* BotSessions;
            return BotSessions.of({
              ...bots,
              rotate: (source, journal, handoff) =>
                bots.rotate(source, journal, handoff).pipe(Effect.andThen(afterCutover)),
            });
          }),
        ).pipe(Layer.provideMerge(basePersistence));
  const baseSessions = SessionStore.layer(AbsolutePath.make(`${root}/sessions`));
  const sessions =
    afterCreatePhysical === undefined
      ? baseSessions
      : Layer.effect(
          AgentSessionStore,
          Effect.gen(function* () {
            const store = yield* AgentSessionStore;
            return AgentSessionStore.of({
              ...store,
              createPhysical: (botRoot, cwd) =>
                store.createPhysical(botRoot, cwd).pipe(Effect.tap(() => afterCreatePhysical)),
            });
          }),
        ).pipe(Layer.provide(baseSessions));
  const runtime = Layer.effect(
    AgentRuntime,
    Effect.gen(function* () {
      const bots = yield* BotSessions;
      const sendTurn: AgentRuntime["Service"]["sendTurn"] = (chatId, input, onEvent) =>
        Effect.gen(function* () {
          const found = yield* bots.findByChat(chatId).pipe(Effect.orDie);
          assert.isTrue(Option.isSome(found));
          if (Option.isNone(found)) return yield* Effect.die("missing bot");
          const handoff = yield* bots.readHandoff(found.value).pipe(Effect.orDie);
          model.opened.push({ bot: found.value, handoff, text: input.text });
          const events: Array<AgentEvent> = [
            { type: "run-started" },
            { type: "text-delta", contentIndex: 0, text: input.text },
            { type: "run-finished", outcome: model.outcome },
          ];
          for (const event of events) yield* onEvent(event);
          return { outcome: model.outcome, events, finalAssistantText: input.text };
        });
      return AgentRuntime.of({
        events: Stream.empty,
        drain: () => Effect.void,
        transcript: () => Effect.succeed([]),
        send: () => Effect.die("bot must capture a whole turn"),
        askBtw: () => Effect.die("unexpected side question"),
        sendCaptured: (chatId, runId, input, onEvent, target) =>
          sendTurn(chatId, input, onEvent, target).pipe(
            Effect.map((result) => ({ ...result, runId })),
          ),
        sendTurn,
        rotate: (_chatId, commit) =>
          model.handoffFailure
            ? Effect.fail(new AgentError({ message: "handoff model unavailable" }))
            : commit(
                "Continue the current task in work/task.txt. Keep the chosen filename and finish the pending edit.",
              ),
        deliver: () => Effect.void,
        publish: () => Effect.void,
        close: () => Effect.die("bot must not archive its conversation"),
        abort: () => Effect.void,
        contextUsage: () => Effect.succeed({ kind: "unavailable" }),
        shake: () => Effect.die("unexpected shake"),
      });
    }),
  ).pipe(Layer.provide(persistence));
  return layer(git).pipe(
    Layer.provide(Layer.mergeAll(runtime, persistence, sessions)),
    Layer.provideMerge(persistence),
  );
};

const currentBot = Effect.fn("BotTest.current")(function* (root: AbsolutePath) {
  const bots = yield* BotSessions;
  const found = yield* bots.findByRoot(root);
  if (Option.isNone(found)) return yield* Effect.die("missing bot");
  return found.value;
});

const setup = Effect.fn("BotTest.setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pico-bot-lifecycle-" });
  return { root, botRoot: AbsolutePath.make(path.join(root, "portable-bot")), fs };
});

const boundary = (): ModelBoundary => ({ handoffFailure: false, outcome: "completed", opened: [] });

const openDatabase = Effect.fn("BotTest.openDatabase")(function* (root: string) {
  return yield* Effect.acquireRelease(
    Effect.sync(() => new Database(`${root}/store.db`)),
    (database) => Effect.sync(() => database.close()),
  );
});

const rowCounts = Effect.fn("BotTest.rowCounts")(function* (root: string) {
  const database = yield* openDatabase(root);
  return yield* Effect.sync(() =>
    database
      .query<{ workspaces: number; chats: number; bots: number }, []>(
        `SELECT
            (SELECT COUNT(*) FROM workspaces) AS workspaces,
            (SELECT COUNT(*) FROM chats) AS chats,
            (SELECT COUNT(*) FROM bot_sessions) AS bots`,
      )
      .get(),
  );
}, Effect.scoped);

const retainedFiles = Effect.fn("BotTest.retainedFiles")(function* (botRoot: AbsolutePath) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(`${botRoot}/work`, { recursive: true });
  yield* fs.makeDirectory(`${botRoot}/sessions`, { recursive: true });
  yield* fs.writeFileString(`${botRoot}/work/task.txt`, "preexisting work");
  yield* fs.writeFileString(`${botRoot}/sessions/retained.jsonl`, "preexisting journal");
});

const retryConversation = Effect.fn("BotTest.retryConversation")(function* (
  root: string,
  botRoot: AbsolutePath,
  retainedJournals: ReadonlyArray<string>,
) {
  const app = yield* Application;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const chats = yield* ChatRepository;
  const workspaces = yield* WorkspaceRepository;
  const chat = yield* app.getOrCreateBotChat({ botRoot, platform: null });
  assert.deepStrictEqual(yield* app.getOrCreateBotChat({ botRoot, platform: null }), chat);
  assert.deepStrictEqual(yield* rowCounts(root), { workspaces: 1, chats: 1, bots: 1 });
  const bot = yield* currentBot(botRoot);
  assert.strictEqual(bot.chatId, chat.id);
  assert.deepStrictEqual(Option.getOrThrow(yield* chats.findById(bot.chatId)), chat);
  const workspace = Option.getOrThrow(yield* workspaces.findById(chat.workspaceId));
  assert.strictEqual(workspace.defaultCwd, `${botRoot}/work`);
  assert.strictEqual(chat.cwd, workspace.defaultCwd);
  assert.strictEqual((yield* fs.stat(bot.journal.file)).type, "File");
  assert.deepStrictEqual(
    (yield* fs.readDirectory(`${botRoot}/sessions`)).sort(),
    [...retainedJournals, path.basename(bot.journal.file)].sort(),
  );
  assert.strictEqual(yield* fs.readFileString(`${botRoot}/work/task.txt`), "preexisting work");
  if (retainedJournals.length !== 0) {
    assert.strictEqual(
      yield* fs.readFileString(`${botRoot}/sessions/retained.jsonl`),
      "preexisting journal",
    );
  }
});

describe("bot conversation provisioning", () => {
  it.effect(
    "leaves no rows when physical journal acquisition fails and preserves existing files",
    () =>
      Effect.gen(function* () {
        const { root, botRoot, fs } = yield* setup();
        yield* fs.makeDirectory(`${botRoot}/work`, { recursive: true });
        yield* fs.writeFileString(`${botRoot}/work/task.txt`, "preexisting work");
        yield* fs.writeFileString(`${botRoot}/sessions`, "preexisting blocker");
        yield* Effect.gen(function* () {
          const app = yield* Application;
          const error = yield* app
            .getOrCreateBotChat({ botRoot, platform: null })
            .pipe(Effect.flip);
          assert.strictEqual(error.reason, "operation");
          assert.deepStrictEqual(yield* rowCounts(root), { workspaces: 0, chats: 0, bots: 0 });
          assert.strictEqual(
            yield* fs.readFileString(`${botRoot}/sessions`),
            "preexisting blocker",
          );
          yield* fs.remove(`${botRoot}/sessions`);
          yield* retryConversation(root, botRoot, []);
        }).pipe(Effect.provide(fixture(root, boundary())));
      }).pipe(Effect.provide(platform)),
  );

  for (const table of ["chats", "bot_sessions"]) {
    it.effect(`rolls back all conversation rows when ${table} publication fails`, () =>
      Effect.gen(function* () {
        const { root, botRoot, fs } = yield* setup();
        yield* retainedFiles(botRoot);
        yield* Effect.gen(function* () {
          const app = yield* Application;
          const database = yield* openDatabase(root);
          yield* Effect.sync(() =>
            database.exec(`
              CREATE TRIGGER reject_publication BEFORE INSERT ON ${table}
              BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END
            `),
          );
          const error = yield* app
            .getOrCreateBotChat({ botRoot, platform: null })
            .pipe(Effect.flip);
          assert.strictEqual(error.reason, "operation");
          assert.deepStrictEqual(yield* rowCounts(root), { workspaces: 0, chats: 0, bots: 0 });
          assert.deepStrictEqual(yield* fs.readDirectory(`${botRoot}/sessions`), [
            "retained.jsonl",
          ]);
          yield* Effect.sync(() => database.exec("DROP TRIGGER reject_publication"));
          yield* retryConversation(root, botRoot, ["retained.jsonl"]);
        }).pipe(Effect.provide(fixture(root, boundary())));
      }).pipe(Effect.provide(platform)),
    );
  }

  it.effect("rolls back a failed COMMIT before releasing the connection and journal", () =>
    Effect.gen(function* () {
      const { root, botRoot, fs } = yield* setup();
      yield* retainedFiles(botRoot);
      yield* Effect.gen(function* () {
        const app = yield* Application;
        const database = yield* openDatabase(root);
        yield* Effect.sync(() =>
          database.exec(`
            CREATE TABLE publication_guard (
              chat_id TEXT REFERENCES chats(id) DEFERRABLE INITIALLY DEFERRED
            );
            CREATE TRIGGER reject_commit AFTER INSERT ON bot_sessions
            BEGIN INSERT INTO publication_guard VALUES ('missing-chat'); END
          `),
        );
        const error = yield* app.getOrCreateBotChat({ botRoot, platform: null }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "operation");
        assert.deepStrictEqual(yield* rowCounts(root), { workspaces: 0, chats: 0, bots: 0 });
        assert.deepStrictEqual(yield* fs.readDirectory(`${botRoot}/sessions`), ["retained.jsonl"]);
        yield* Effect.sync(() => {
          assert.deepStrictEqual(database.query("SELECT * FROM publication_guard").all(), []);
          database.exec("DROP TRIGGER reject_commit");
        });
        yield* retryConversation(root, botRoot, ["retained.jsonl"]);
      }).pipe(Effect.provide(fixture(root, boundary())));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("keeps one complete conversation when interrupted during journal acquisition", () =>
    Effect.gen(function* () {
      const { root, botRoot } = yield* setup();
      yield* retainedFiles(botRoot);
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const pause = Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      yield* Effect.gen(function* () {
        const app = yield* Application;
        const opening = yield* app
          .getOrCreateBotChat({ botRoot, platform: null })
          .pipe(Effect.forkChild);
        yield* Deferred.await(reached);
        assert.deepStrictEqual(yield* rowCounts(root), { workspaces: 0, chats: 0, bots: 0 });
        const interrupt = yield* Fiber.interrupt(opening).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupt);
        const exit = yield* Fiber.await(opening);
        assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
        yield* retryConversation(root, botRoot, ["retained.jsonl"]);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(fixture(root, boundary(), { afterCreatePhysical: pause })),
      );
    }).pipe(Effect.provide(platform)),
  );
});

describe("bot session continuity", () => {
  it.effect(
    "converges first inputs, rotates on size, and reopens the new journal after restart",
    () =>
      Effect.gen(function* () {
        const { root, botRoot, fs } = yield* setup();
        const model = boundary();
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* Application;
            const [a, b] = yield* Effect.all(
              [
                app.getOrCreateBotChat({ botRoot, platform: null }),
                app.getOrCreateBotChat({ botRoot, platform: null }),
              ],
              { concurrency: "unbounded" },
            );
            assert.strictEqual(a.id, b.id);
            assert.strictEqual(a.cwd, `${botRoot}/work`);
            yield* fs.writeFileString(`${a.cwd}/task.txt`, "durable work");
            yield* app.sendBotMessage(a.id, prompt("first"), () => Effect.void);
            const before = yield* currentBot(botRoot);
            yield* fs.truncate(before.journal.file, BOT_JOURNAL_MAX_BYTES);
            yield* app.sendBotMessage(a.id, prompt("second"), () => Effect.void);
            const after = yield* currentBot(botRoot);
            assert.notStrictEqual(after.journal.id, before.journal.id);
            assert.strictEqual(after.chatId, before.chatId);
            assert.isTrue(yield* fs.exists(before.journal.file));
            assert.strictEqual(yield* fs.readFileString(`${a.cwd}/task.txt`), "durable work");
            assert.include(model.opened[1]?.handoff ?? "", "pending edit");
            return after;
          }).pipe(Effect.provide(fixture(root, model))),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* Application;
            const reopened = yield* app.getOrCreateBotChat({ botRoot, platform: null });
            assert.strictEqual(reopened.id, first.chatId);
            yield* app.sendBotMessage(reopened.id, prompt("after restart"), () => Effect.void);
            assert.strictEqual((yield* currentBot(botRoot)).journal.id, first.journal.id);
            assert.strictEqual(model.opened[2]?.bot.journal.id, first.journal.id);
          }).pipe(Effect.provide(fixture(root, model))),
        );
      }).pipe(Effect.provide(platform)),
  );

  it.effect("retains the completed journal and rejects new input when the handoff fails", () =>
    Effect.gen(function* () {
      const { root, botRoot } = yield* setup();
      const model = boundary();
      yield* Effect.gen(function* () {
        const app = yield* Application;
        const chat = yield* app.getOrCreateBotChat({ botRoot, platform: null });
        yield* app.sendBotMessage(chat.id, prompt("completed task"), () => Effect.void);
        const before = yield* currentBot(botRoot);
        yield* TestClock.adjust(BOT_SESSION_IDLE_MS);
        model.handoffFailure = true;
        const error = yield* app
          .sendBotMessage(chat.id, prompt("not admitted"), () => Effect.void)
          .pipe(Effect.flip);
        assert.include(error.message, "handoff model unavailable");
        assert.deepStrictEqual(yield* currentBot(botRoot), before);
        assert.deepStrictEqual(
          model.opened.map((entry) => entry.text),
          ["completed task"],
        );
        model.handoffFailure = false;
        yield* app.sendBotMessage(chat.id, prompt("retry"), () => Effect.void);
        assert.notStrictEqual((yield* currentBot(botRoot)).journal.id, before.journal.id);
      }).pipe(Effect.provide(fixture(root, model)));
    }).pipe(Effect.provide(platform)),
  );

  it.effect(
    "keeps incomplete sessions and holds the queue until the previous reply sink finishes",
    () =>
      Effect.gen(function* () {
        const { root, botRoot, fs } = yield* setup();
        const model = boundary();
        yield* Effect.gen(function* () {
          const app = yield* Application;
          const chat = yield* app.getOrCreateBotChat({ botRoot, platform: null });
          model.outcome = "failed";
          yield* app
            .sendBotMessage(chat.id, prompt("partial"), () => Effect.void)
            .pipe(Effect.flip);
          const pending = yield* currentBot(botRoot);
          assert.strictEqual(pending.turn.kind, "pending");
          yield* fs.truncate(pending.journal.file, BOT_JOURNAL_MAX_BYTES);
          yield* TestClock.adjust(BOT_SESSION_IDLE_MS);
          model.outcome = "completed";
          const blocked = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const replies: Array<string> = [];
          const a = yield* app
            .sendBotMessage(chat.id, prompt("sender A"), (event) =>
              Effect.gen(function* () {
                if (event.type !== "text-delta") return;
                replies.push(`A:${event.text}`);
                yield* Deferred.succeed(blocked, undefined);
                yield* Deferred.await(release);
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(blocked);
          const b = yield* app
            .sendBotMessage(chat.id, prompt("sender B"), (event) =>
              Effect.sync(() => {
                if (event.type === "text-delta") replies.push(`B:${event.text}`);
              }),
            )
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.deepStrictEqual(replies, ["A:sender A"]);
          assert.strictEqual(model.opened[1]?.bot.journal.id, pending.journal.id);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(a);
          yield* Fiber.join(b);
          assert.deepStrictEqual(replies, ["A:sender A", "B:sender B"]);
          assert.notStrictEqual(model.opened[2]?.bot.journal.id, pending.journal.id);
        }).pipe(Effect.provide(fixture(root, model)));
      }).pipe(Effect.provide(platform)),
  );

  it.effect("does not delete a published journal when interruption arrives during cutover", () =>
    Effect.gen(function* () {
      const { root, botRoot, fs } = yield* setup();
      const model = boundary();
      const committed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const afterCutover = Deferred.succeed(committed, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      yield* Effect.gen(function* () {
        const app = yield* Application;
        const chat = yield* app.getOrCreateBotChat({ botRoot, platform: null });
        yield* app.sendBotMessage(chat.id, prompt("first"), () => Effect.void);
        const source = yield* currentBot(botRoot);
        yield* TestClock.adjust(BOT_SESSION_IDLE_MS);
        const turn = yield* app
          .sendBotMessage(chat.id, prompt("interrupted"), () => Effect.void)
          .pipe(Effect.forkChild);
        yield* Deferred.await(committed);
        const interrupt = yield* Fiber.interrupt(turn).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupt);
        const active = yield* currentBot(botRoot);
        assert.notStrictEqual(active.journal.id, source.journal.id);
        assert.isTrue(yield* fs.exists(active.journal.file));
        assert.isTrue(yield* fs.exists(source.journal.file));
        assert.strictEqual(active.turn.kind, "fresh");
      }).pipe(Effect.provide(fixture(root, model, { afterCutover })));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("keeps workspace schedules on the bot queue and rotates their shared journal", () =>
    Effect.gen(function* () {
      const { root, botRoot, fs } = yield* setup();
      const model = boundary();
      yield* Effect.gen(function* () {
        const app = yield* Application;
        const host = yield* Schedule.ScheduleRunHostService;
        const chats = yield* ChatRepository;
        const chat = yield* app.getOrCreateBotChat({ botRoot, platform: "discord" });
        const plannedChatId = ChatId.make("018f47a0-0000-7000-8000-000000000088");
        const target = yield* host.prepare({
          kind: "workspace-chat",
          ownerWorkspaceId: chat.workspaceId,
          chatId: plannedChatId,
        });
        assert.strictEqual(target.chatId, chat.id);
        assert.strictEqual(target.cwd, chat.cwd);
        assert.isTrue(Option.isNone(yield* chats.findById(plannedChatId)));
        assert.isFalse(yield* fs.exists(`${root}/sessions/${plannedChatId}.jsonl`));
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const dm = yield* app
          .sendBotMessage(chat.id, prompt("DM first"), (event) =>
            event.type === "text-delta"
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const before = yield* currentBot(botRoot);
        yield* fs.truncate(before.journal.file, BOT_JOURNAL_MAX_BYTES);
        const runId = Schedule.ScheduleRunId.make(
          "scheduled-1000-018f47a0-0000-7000-8000-000000000089",
        );
        const scheduled = yield* host
          .runPrompt(target.chatId, runId, prompt("workspace reminder"), () => Effect.void, {
            platform: "discord",
            conversationId: "11",
            messageId: "101",
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(
          model.opened.map((entry) => entry.text),
          ["DM first"],
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(dm);
        const result = yield* Fiber.join(scheduled);
        assert.strictEqual(result.outcome, "completed");
        const after = yield* currentBot(botRoot);
        assert.notStrictEqual(after.journal.id, before.journal.id);
        assert.strictEqual(model.opened[1]?.bot.journal.id, after.journal.id);
        assert.strictEqual(model.opened[1]?.bot.chatId, chat.id);
        assert.strictEqual(model.opened[1]?.bot.botRoot, botRoot);
      }).pipe(Effect.provide(fixture(root, model)));
    }).pipe(Effect.provide(platform)),
  );
});
