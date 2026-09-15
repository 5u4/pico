import { assert, describe, it } from "@effect/vitest";
import type { AgentEvent, AgentEventEnvelope } from "@pico/contract/agent-event";
import type { AgentAssistantMessage } from "@pico/contract/agent-message";
import * as Chat from "@pico/contract/chat-model";
import { ScheduleHostError } from "@pico/contract/schedule";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { promiseBoundary, reportFailure } from "./discord-error.ts";
import {
  type DiscordOutputPolicy,
  make,
  makeScheduledSender,
  type RenderedMessage,
  renderAssistant,
} from "./discord-output.ts";

const chatA = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");
const chatB = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const hiddenPolicy: DiscordOutputPolicy = {
  showToolCalls: false,
  showThinking: false,
};
const visiblePolicy: DiscordOutputPolicy = {
  showToolCalls: true,
  showThinking: true,
};
const envelope = (chatId: Chat.ChatId, event: AgentEvent): AgentEventEnvelope => ({
  chatId,
  event,
});

const completed = (
  stopReason: "stop" | "length" | "tool-use",
  content: AgentAssistantMessage["content"],
): AgentAssistantMessage => ({
  role: "assistant",
  status: "completed",
  stopReason,
  content,
  model: "test",
  timestamp: 0,
});

const failed = (
  stopReason: "error" | "aborted",
  content: AgentAssistantMessage["content"] = [],
): AgentAssistantMessage => ({
  role: "assistant",
  status: "failed",
  stopReason,
  message: "private runtime detail",
  content,
  model: "test",
  timestamp: 0,
});

describe("Discord output", () => {
  it.effect("stops scheduled delivery after a rejected chunk and returns the transport error", () =>
    Effect.gen(function* () {
      const attempted: Array<{ readonly channelId: bigint; readonly message: RenderedMessage }> =
        [];
      const send = makeScheduledSender({
        send: (channelId, message) =>
          promiseBoundary("send-message", async () => {
            attempted.push({ channelId, message });
            if (attempted.length === 2) {
              throw new Error("private-sdk-wrapper", {
                cause: { status: 503, body: '{"code":50013,"message":"private-response"}' },
              });
            }
            return BigInt(attempted.length);
          }),
      });
      const failure = yield* send({
        chatId: chatA,
        externalId: "101",
        content: "x".repeat(4_500),
      }).pipe(Effect.flip);
      assert.instanceOf(failure, ScheduleHostError);
      assert.include(failure.message, "503");
      assert.include(failure.message, "50013");
      assert.notInclude(JSON.stringify(failure), "private-");
      assert.deepStrictEqual(attempted, [
        { channelId: 101n, message: { content: "x".repeat(2_000), silent: false } },
        { channelId: 101n, message: { content: "x".repeat(2_000), silent: false } },
      ]);
    }),
  );

  it.effect("rejects invalid scheduled thread IDs and retains snowflake precision", () =>
    Effect.gen(function* () {
      const sent: Array<{ readonly channelId: bigint; readonly message: RenderedMessage }> = [];
      const send = makeScheduledSender({
        send: (channelId, message) =>
          Effect.sync(() => {
            sent.push({ channelId, message });
            return 1n;
          }),
      });
      for (const externalId of [" ", "-1", "18446744073709551616"]) {
        const failure = yield* send({ chatId: chatA, externalId, content: "not sent" }).pipe(
          Effect.flip,
        );
        assert.instanceOf(failure, ScheduleHostError);
      }
      assert.deepStrictEqual(sent, []);
      yield* send({
        chatId: chatA,
        externalId: "18446744073709551615",
        content: "exact destination",
      });
      assert.deepStrictEqual(sent, [
        {
          channelId: 18_446_744_073_709_551_615n,
          message: { content: "exact destination", silent: false },
        },
      ]);
    }),
  );

  it("renders committed content in order with safe notification policy", () => {
    const rendered = renderAssistant(
      completed("stop", [
        { type: "thinking", text: "checking" },
        { type: "text", text: "| A | B |\n| --- | --- |\n| x | y |" },
      ]),
      true,
    );

    assert.deepStrictEqual(rendered[0], { content: "🧠 checking", silent: true });
    assert.deepStrictEqual(rendered[1], {
      content: "- **x**\n  - B: y",
      silent: false,
    });
    assert.isTrue(
      renderAssistant(completed("tool-use", [{ type: "text", text: "working" }]), true)[0]?.silent,
    );
    assert.include(
      renderAssistant(completed("length", [{ type: "text", text: "partial" }]), true).at(-1)
        ?.content,
      "length limit",
    );
    assert.deepStrictEqual(
      renderAssistant(failed("error", [{ type: "text", text: "partial" }]), true),
      [
        { content: "partial", silent: false },
        { content: "The request failed.", silent: false },
      ],
    );
    const thinking = renderAssistant(
      completed("stop", [{ type: "thinking", text: "x".repeat(1_000) }]),
      true,
    )[0];
    assert.strictEqual(Array.from(thinking?.content ?? "").length, 800);
  });

  it("does not render absent, empty, or whitespace-only thinking", () => {
    assert.deepStrictEqual(renderAssistant(completed("stop", []), true), []);
    assert.deepStrictEqual(
      renderAssistant(
        completed("stop", [
          { type: "thinking", text: "" },
          { type: "thinking", text: " \n\t" },
        ]),
        true,
      ),
      [],
    );
  });

  it.effect("hides tool activity and committed thinking without hiding text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sent: RenderedMessage[] = [];
        const edited: string[] = [];
        const scope = yield* Scope.Scope;
        const dispatch = make(
          {
            send: (_threadId, message) =>
              Effect.sync(() => {
                sent.push(message);
                return 1n;
              }),
            edit: (_threadId, _messageId, content) =>
              Effect.sync(() => {
                edited.push(content);
              }),
            renameThread: () => Effect.void,
            triggerTyping: () => Effect.void,
          },
          scope,
          hiddenPolicy,
        );
        const hiddenToolStarted: AgentEvent = {
          type: "tool-started",
          toolCallId: "hidden",
          toolName: "read",
          get argumentsJson(): string {
            throw new Error("Hidden tool arguments were read");
          },
        };

        yield* dispatch(11n, envelope(chatA, hiddenToolStarted));
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-finished",
            toolCallId: "hidden",
            toolName: "read",
            status: "succeeded",
          }),
        );
        assert.deepStrictEqual(sent, []);
        assert.deepStrictEqual(edited, []);
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "message-settled",
            message: completed("stop", [
              { type: "thinking", text: "private reasoning" },
              { type: "text", text: "visible answer" },
            ]),
          }),
        );

        assert.deepStrictEqual(sent, [{ content: "visible answer", silent: false }]);
        assert.deepStrictEqual(edited, []);
      }),
    ),
  );

  it.effect("isolates tool correlation, renews typing, and claims terminal output once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sent: Array<{ readonly threadId: bigint; readonly message: RenderedMessage }> = [];
        const edited: Array<{
          readonly threadId: bigint;
          readonly messageId: bigint;
          readonly content: string;
        }> = [];
        const typing: bigint[] = [];
        let nextId = 1n;
        const scope = yield* Scope.Scope;
        const dispatch = make(
          {
            send: (threadId, message) =>
              Effect.sync(() => {
                sent.push({ threadId, message });
                return nextId++;
              }),
            edit: (threadId, messageId, content) =>
              Effect.sync(() => {
                edited.push({ threadId, messageId, content });
              }),
            renameThread: () => Effect.void,
            triggerTyping: (threadId) =>
              Effect.sync(() => {
                typing.push(threadId);
              }),
          },
          scope,
          visiblePolicy,
        );

        yield* dispatch(11n, envelope(chatA, { type: "run-started" }));
        yield* Effect.yieldNow;
        assert.deepStrictEqual(typing, [11n]);
        yield* TestClock.adjust("8 seconds");
        yield* Effect.yieldNow;
        assert.deepStrictEqual(typing, [11n, 11n]);

        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-started",
            toolCallId: "same-id",
            toolName: "bash",
            argumentsJson: '{"command":"bun run test"}',
          }),
        );
        yield* dispatch(
          22n,
          envelope(chatB, {
            type: "tool-started",
            toolCallId: "same-id",
            toolName: "read",
            argumentsJson: '{"path":"packages/discord/src/layer.ts"}',
          }),
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-finished",
            toolCallId: "same-id",
            toolName: "bash",
            status: "succeeded",
          }),
        );
        yield* dispatch(
          22n,
          envelope(chatB, {
            type: "tool-finished",
            toolCallId: "same-id",
            toolName: "read",
            status: "failed",
          }),
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-started",
            toolCallId: "unknown-id",
            toolName: "future_tool",
            argumentsJson: '{"token":"unknown-secret"}',
          }),
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-finished",
            toolCallId: "unknown-id",
            toolName: "future_tool",
            status: "failed",
          }),
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-started",
            toolCallId: "read-success",
            toolName: "read",
            argumentsJson: '{"path":"packages/discord/src/layer.ts"}',
          }),
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-finished",
            toolCallId: "read-success",
            toolName: "read",
            status: "succeeded",
          }),
        );
        assert.deepStrictEqual(sent.slice(0, 4), [
          { threadId: 11n, message: { content: "💻 Running bun run test…", silent: true } },
          {
            threadId: 22n,
            message: {
              content: "📖 Reading packages/discord/src/layer.ts…",
              silent: true,
            },
          },
          { threadId: 11n, message: { content: "⚙️ future_tool…", silent: true } },
          {
            threadId: 11n,
            message: {
              content: "📖 Reading packages/discord/src/layer.ts…",
              silent: true,
            },
          },
        ]);
        assert.deepStrictEqual(
          edited.map(({ threadId, messageId, content }) => [threadId, messageId, content]),
          [
            [11n, 1n, sent[0]?.message.content.slice(0, -1)],
            [22n, 2n, sent[1]?.message.content.replace(/^\S+/u, "❌").slice(0, -1)],
            [11n, 3n, sent[2]?.message.content.replace(/^\S+/u, "❌").slice(0, -1)],
            [11n, 4n, sent[3]?.message.content.slice(0, -1)],
          ],
        );
        assert.isFalse(sent.some(({ message }) => message.content.includes("secret")));

        yield* dispatch(
          11n,
          envelope(chatA, { type: "message-settled", message: failed("error") }),
        );
        yield* dispatch(11n, envelope(chatA, { type: "run-finished", outcome: "failed" }));
        assert.strictEqual(
          sent.filter(({ message }) => message.content === "The request failed.").length,
          1,
        );
        const typingCount = typing.length;
        yield* TestClock.adjust("8 seconds");
        yield* Effect.yieldNow;
        assert.strictEqual(typing.length, typingCount);

        yield* dispatch(
          11n,
          envelope(chatA, { type: "text-delta", contentIndex: 0, text: "ignored" }),
        );
        yield* dispatch(
          11n,
          envelope(chatA, { type: "thinking-delta", contentIndex: 0, text: "ignored" }),
        );
        assert.isFalse(sent.some(({ message }) => message.content === "ignored"));
      }),
    ),
  );

  it.effect("waits for title renames before completing dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const renameStarted = yield* Deferred.make<void>();
        const releaseRename = yield* Deferred.make<void>();
        const dispatchCompleted = yield* Deferred.make<void>();
        const scope = yield* Scope.Scope;
        const dispatch = make(
          {
            send: () => Effect.die("unexpected message"),
            edit: () => Effect.die("unexpected edit"),
            renameThread: () =>
              Deferred.succeed(renameStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRename)),
              ),
            triggerTyping: () => Effect.die("unexpected typing"),
          },
          scope,
          visiblePolicy,
        );

        yield* dispatch(11n, envelope(chatA, { type: "title-changed", title: "Closed chat" })).pipe(
          Effect.ensuring(Deferred.succeed(dispatchCompleted, undefined)),
          Effect.forkChild,
        );
        yield* Deferred.await(renameStarted);
        assert.isFalse(yield* Deferred.isDone(dispatchCompleted));
        yield* Deferred.succeed(releaseRename, undefined);
        yield* Deferred.await(dispatchCompleted);
      }),
    ),
  );

  it.effect("curates tool targets without exposing malformed or unknown arguments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sent: RenderedMessage[] = [];
        const edited: string[] = [];
        let nextId = 1n;
        const scope = yield* Scope.Scope;
        const dispatch = make(
          {
            send: (_threadId, message) =>
              Effect.sync(() => {
                sent.push(message);
                return nextId++;
              }),
            edit: (_threadId, _messageId, content) =>
              Effect.sync(() => {
                edited.push(content);
              }),
            renameThread: () => Effect.void,
            triggerTyping: () => Effect.void,
          },
          scope,
          visiblePolicy,
        );
        const start = (toolCallId: string, toolName: string, argumentsJson: string) =>
          dispatch(
            11n,
            envelope(chatA, {
              type: "tool-started",
              toolCallId,
              toolName,
              argumentsJson,
            }),
          );
        const finish = (toolCallId: string, toolName: string, status: "succeeded" | "failed") =>
          dispatch(11n, envelope(chatA, { type: "tool-finished", toolCallId, toolName, status }));

        yield* start("array", "ast_edit", '{"paths":["src/a.ts","src/b.ts"],"path":"ignored.ts"}');
        yield* finish("array", "ast_edit", "succeeded");
        yield* start("precedence", "grep", '{"pattern":"tool-started","path":"private.ts"}');
        yield* finish("precedence", "grep", "succeeded");
        yield* start("malformed", "read", "{private");
        yield* finish("malformed", "read", "succeeded");
        yield* start("non-object", "read", '"private"');
        yield* finish("non-object", "read", "failed");
        yield* start("unknown", "future_tool", '{"token":"unknown-secret"}');
        yield* finish("unknown", "future_tool", "succeeded");

        const longTarget = "x".repeat(1_000);
        yield* start("long", "read", JSON.stringify({ path: longTarget }));
        yield* finish("long", "read", "succeeded");
        yield* finish("finish-before-start", "read", "failed");
        yield* start("canceled", "read", '{"path":"cancel.ts"}');
        yield* dispatch(11n, envelope(chatA, { type: "run-finished", outcome: "completed" }));

        assert.deepStrictEqual(
          sent.slice(0, 5).map(({ content }) => content),
          [
            "✏️ Editing src/a.ts, src/b.ts…",
            "🔎 Searching tool-started…",
            "📖 Reading input…",
            "📖 Reading input…",
            "⚙️ future_tool…",
          ],
        );
        assert.deepStrictEqual(edited.slice(0, 5), [
          sent[0]?.content.slice(0, -1),
          sent[1]?.content.slice(0, -1),
          sent[2]?.content.slice(0, -1),
          sent[3]?.content.replace(/^\S+/u, "❌").slice(0, -1),
          sent[4]?.content.slice(0, -1),
        ]);
        assert.strictEqual(sent[6]?.content, edited[3]);
        assert.strictEqual(sent[6]?.silent, true);
        assert.deepStrictEqual(sent[7], { content: "📖 Reading cancel.ts…", silent: true });
        assert.strictEqual(edited[6], "📖 Reading cancel.ts canceled.");
        assert.isAtMost(Array.from(sent[5]?.content ?? "").length, 500);
        assert.isAtMost(Array.from(edited[5] ?? "").length, 500);
        assert.isTrue(sent.every(({ silent }) => silent));
        assert.isFalse(
          [...sent.map(({ content }) => content), ...edited].some(
            (content) => content.includes("private") || content.includes("ignored.ts"),
          ),
        );
      }),
    ),
  );

  it.effect("falls back to one silent message when a tool edit fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sent: RenderedMessage[] = [];
        const scope = yield* Scope.Scope;
        const dispatch = make(
          {
            send: (_threadId, message) =>
              Effect.sync(() => {
                sent.push(message);
                return 1n;
              }),
            edit: () => Effect.fail("edit failed"),
            renameThread: () => Effect.void,
            triggerTyping: () => Effect.void,
          },
          scope,
          visiblePolicy,
        );

        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-started",
            toolCallId: "tool-1",
            toolName: "bash",
            argumentsJson: "{}",
          }),
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-finished",
            toolCallId: "tool-1",
            toolName: "bash",
            status: "succeeded",
          }),
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-finished",
            toolCallId: "tool-1",
            toolName: "bash",
            status: "succeeded",
          }),
        );
        assert.strictEqual(sent.length, 2);
        assert.strictEqual(sent[1]?.content, sent[0]?.content.slice(0, -1));
        assert.strictEqual(sent[1]?.silent, true);
      }),
    ),
  );

  it.effect("contains rename failures without failing later output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const renamed: Array<{ readonly threadId: bigint; readonly title: string }> = [];
        const sent: Array<{ readonly threadId: bigint; readonly message: RenderedMessage }> = [];
        const scope = yield* Scope.Scope;
        const dispatch = make(
          {
            send: (threadId, message) =>
              Effect.sync(() => {
                sent.push({ threadId, message });
                return 1n;
              }),
            edit: () => Effect.void,
            renameThread: (threadId, title) =>
              Effect.sync(() => {
                renamed.push({ threadId, title });
              }).pipe(Effect.andThen(Effect.fail("rename failed"))),
            triggerTyping: () => Effect.void,
          },
          scope,
          visiblePolicy,
        );

        yield* dispatch(22n, envelope(chatB, { type: "title-changed", title: "Failed rename" }));
        yield* dispatch(
          22n,
          envelope(chatB, {
            type: "message-settled",
            message: completed("tool-use", [{ type: "text", text: "after failure" }]),
          }),
        );

        assert.deepStrictEqual(renamed, [{ threadId: 22n, title: "Failed rename" }]);
        assert.deepStrictEqual(
          sent.map(({ threadId, message }) => [threadId, message.content]),
          [[22n, "after failure"]],
        );
      }),
    ),
  );
  it.effect("warns only after edit recovery and reports failed replacement once", () => {
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
    const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
    return Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        let sendFails = false;
        const dispatch = make(
          {
            send: () =>
              sendFails
                ? Effect.fail(
                    new Error("private-send-wrapper", {
                      cause: { status: 503, body: "private-send-body" },
                    }),
                  )
                : Effect.succeed(1n),
            edit: () =>
              Effect.fail(
                new Error("private-edit-wrapper", {
                  cause: { status: 403, body: '{"code":50013,"message":"private-edit-body"}' },
                }),
              ),
            renameThread: () => Effect.void,
            triggerTyping: () => Effect.void,
          },
          scope,
          visiblePolicy,
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-started",
            toolCallId: "first",
            toolName: "bash",
            argumentsJson: "{}",
          }),
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-finished",
            toolCallId: "first",
            toolName: "bash",
            status: "succeeded",
          }),
        );
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]?.annotations.outcome, "sent-replacement");
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-started",
            toolCallId: "second",
            toolName: "bash",
            argumentsJson: "{}",
          }),
        );
        sendFails = true;
        const result = yield* Effect.exit(
          dispatch(
            11n,
            envelope(chatA, {
              type: "tool-finished",
              toolCallId: "second",
              toolName: "bash",
              status: "succeeded",
            }),
          ),
        );
        assert.isTrue(Exit.isFailure(result));
        assert.strictEqual(logs.length, 1);
        if (Exit.isFailure(result)) yield* reportFailure("deliver-event", result.cause);
        assert.strictEqual(logs.length, 2);
        assert.strictEqual(logs[1]?.annotations.discordOperation, "edit-message-fallback");
        assert.strictEqual(logs[1]?.annotations.status, 503);
        assert.strictEqual(logs[1]?.annotations.editStatus, 403);
        assert.strictEqual(logs[1]?.annotations.editDiscordCode, 50013);
        assert.notInclude(JSON.stringify(logs), "private-");
      }),
    ).pipe(Effect.provide(Logger.layer([logger])));
  });

  it.effect("silently replaces a tool message deleted from Discord", () => {
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
    const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
    return Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const sent: RenderedMessage[] = [];
        const dispatch = make(
          {
            send: (_threadId, message) =>
              Effect.sync(() => {
                sent.push(message);
                return 1n;
              }),
            edit: () =>
              Effect.fail(
                new Error("private-sdk-wrapper", {
                  cause: { status: 404, body: '{"code":10008,"message":"private-response"}' },
                }),
              ),
            renameThread: () => Effect.void,
            triggerTyping: () => Effect.void,
          },
          scope,
          visiblePolicy,
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-started",
            toolCallId: "deleted",
            toolName: "bash",
            argumentsJson: "{}",
          }),
        );
        yield* dispatch(
          11n,
          envelope(chatA, {
            type: "tool-finished",
            toolCallId: "deleted",
            toolName: "bash",
            status: "succeeded",
          }),
        );
        assert.strictEqual(sent.length, 2);
        assert.strictEqual(sent[1]?.content, sent[0]?.content.slice(0, -1));
        assert.strictEqual(sent[1]?.silent, true);
        assert.deepStrictEqual(logs, []);
      }),
    ).pipe(Effect.provide(Logger.layer([logger])));
  });

  it.effect("logs one degraded typing transition, recovery, and no shutdown failure", () => {
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
    const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
    return Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        let attempts = 0;
        const dispatch = make(
          {
            send: () => Effect.succeed(1n),
            edit: () => Effect.void,
            renameThread: () => Effect.void,
            triggerTyping: () =>
              Effect.suspend(() => {
                attempts++;
                return attempts < 3 ? Effect.fail(new Error("private-typing-error")) : Effect.void;
              }),
          },
          scope,
          hiddenPolicy,
        );
        yield* dispatch(11n, envelope(chatA, { type: "run-started" }));
        yield* TestClock.adjust("8 seconds");
        assert.strictEqual(attempts, 2);
        assert.strictEqual(logs.length, 1);
        yield* TestClock.adjust("8 seconds");
        assert.strictEqual(attempts, 3);
        assert.strictEqual(logs.length, 2);
        assert.strictEqual(logs[1]?.annotations.outcome, "recovered");
        yield* dispatch(11n, envelope(chatA, { type: "run-finished", outcome: "completed" }));
        yield* TestClock.adjust("8 seconds");
        assert.strictEqual(attempts, 3);
        assert.strictEqual(logs.length, 2);
        assert.notInclude(JSON.stringify(logs), "private-");
      }),
    ).pipe(Effect.provide(Logger.layer([logger])));
  });
});
