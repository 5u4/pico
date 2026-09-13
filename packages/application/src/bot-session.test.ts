import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type { AgentEvent } from "@pico/contract/agent-event";
import { AgentPrompt } from "@pico/contract/agent-message";
import { AgentRuntime, type AgentTurnResult } from "@pico/contract/agent-runtime";
import { Application } from "@pico/contract/application";
import { type BotSession, BotSessions } from "@pico/contract/bot-session";
import { ChatId } from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AgentError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import type { GitWorktree } from "@pico/contract/worktree";
import * as SessionStore from "@pico/omp/agent-session-store";
import * as Persistence from "@pico/persistence/layer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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

const fixture = (root: string, model: ModelBoundary, afterCutover?: Effect.Effect<void>) => {
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
    Layer.provide(
      Layer.mergeAll(
        runtime,
        persistence,
        SessionStore.layer(AbsolutePath.make(`${root}/sessions`)),
      ),
    ),
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
      }).pipe(Effect.provide(fixture(root, model, afterCutover)));
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
