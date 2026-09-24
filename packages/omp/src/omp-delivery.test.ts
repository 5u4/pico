import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ImageContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { PromptDeliveryObserver } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const importNative = async () => {
  const [
    core,
    ai,
    sessions,
    managers,
    settings,
    registries,
    messages,
    rpc,
    extensions,
    loaders,
    events,
    sender,
    normalization,
    sessionLoader,
  ] = await Promise.all([
    import("@oh-my-pi/pi-agent-core"),
    import("@oh-my-pi/pi-ai"),
    import("@oh-my-pi/pi-coding-agent/session/agent-session"),
    import("@oh-my-pi/pi-coding-agent/session/session-manager"),
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    import("@oh-my-pi/pi-coding-agent/config/model-registry"),
    import("@oh-my-pi/pi-coding-agent/session/messages"),
    import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode"),
    import("@oh-my-pi/pi-coding-agent/extensibility/extensions/runner"),
    import("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"),
    import("@oh-my-pi/pi-coding-agent/utils/event-bus"),
    import("./omp-prompt-sender.ts"),
    import("./agent-event.ts"),
    import("@oh-my-pi/pi-coding-agent/session/session-loader"),
  ]);
  return {
    ...core,
    ...ai,
    ...sessions,
    ...managers,
    ...settings,
    ...registries,
    ...messages,
    ...rpc,
    ...extensions,
    ...loaders,
    ...events,
    ...sender,
    ...normalization,
    ...sessionLoader,
  };
};

let native: Awaited<ReturnType<typeof importNative>>;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pico-native-delivery-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("OMP_PROFILE", "default");
  vi.stubEnv("PI_PROFILE", "default");
  vi.stubEnv("PI_TEST_RUNTIME", "1");
  vi.stubEnv("PI_NO_TITLE", "1");
  native = await importNative();
}, 30_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

type DeliveryEvent = Parameters<PromptDeliveryObserver["onAccepted"]>[0] | "consumed" | "discarded";

const observeDelivery = () => {
  const events: DeliveryEvent[] = [];
  const accepted = Promise.withResolvers<Parameters<PromptDeliveryObserver["onAccepted"]>[0]>();
  const settled = Promise.withResolvers<"consumed" | "discarded">();
  const observer: PromptDeliveryObserver = {
    onAccepted: (delivery) => {
      events.push(delivery);
      accepted.resolve(delivery);
    },
    onConsumed: () => {
      events.push("consumed");
      settled.resolve("consumed");
    },
    onDiscarded: () => {
      events.push("discarded");
      settled.resolve("discarded");
    },
  };
  return { observer, events, accepted: accepted.promise, settled: settled.promise };
};

const providerTurn = () => ({
  entered: Promise.withResolvers<Context>(),
  release: Promise.withResolvers<void>(),
});

const assistantMessage = (model: AgentSession["model"]): AssistantMessage => {
  if (!model) throw new Error("Delivery test requires a model");
  return {
    role: "assistant",
    content: [{ type: "text", text: "Provider turn completed." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
};

const withSession = async (
  turns: ReturnType<typeof providerTurn>[],
  run: (session: AgentSession, directory: string) => Promise<void>,
  extensionFactory?: ExtensionFactory,
  skillsSettings = { enableSkillCommands: true },
) => {
  const directory = await mkdtemp(join(root, "session-"));
  const auth = new native.AuthStorage(
    await native.SqliteAuthCredentialStore.open(join(directory, "auth.db")),
  );
  auth.keys.setRuntime("openai", "local-provider-only");
  const settings = native.Settings.isolated({
    "compaction.enabled": false,
    "retry.enabled": false,
    "retry.usageAwareFallback": false,
    "memory.backend": "off",
    "power.sleepPrevention": "off",
    "todo.enabled": false,
    "ttsr.enabled": false,
    "magicKeywords.enabled": false,
    "secrets.enabled": false,
    "git.enabled": false,
    "lsp.enabled": false,
  });
  const registry = new native.ModelRegistry(auth, join(directory, "models.yml"), {
    settings,
    ignoreLocalModelConfig: true,
    fetch: () => Promise.reject(new Error("Network is not part of delivery tests")),
  });
  const model = registry.find("openai", "gpt-4.1");
  if (!model) throw new Error("Pinned OMP catalog has no gpt-4.1 model");
  let nextTurn = 0;
  const streamFn: StreamFn = (requestedModel, context, options) => {
    const turn = turns[nextTurn++];
    if (!turn) throw new Error("Unexpected native provider turn");
    const stream = new AssistantMessageEventStream();
    const response = assistantMessage(requestedModel);
    const abort = () => turn.release.resolve();
    options?.signal?.addEventListener("abort", abort, { once: true });
    turn.entered.resolve(context);
    if (options?.signal?.aborted) abort();
    void turn.release.promise.then(() => {
      options?.signal?.removeEventListener("abort", abort);
      if (options?.signal?.aborted) {
        response.stopReason = "aborted";
        response.errorMessage = "Request was aborted";
        stream.push({ type: "error", reason: "aborted", error: response });
      } else {
        stream.push({ type: "done", reason: "stop", message: response });
      }
      stream.end();
    });
    return stream;
  };
  const agent = new native.Agent({
    initialState: { model, systemPrompt: ["Use the local delivery test provider."], tools: [] },
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    convertToLlm: native.convertToLlm,
    streamFn,
    getApiKey: () => "local-provider-only",
  });
  const skillPath = join(directory, "SKILL.md");
  await writeFile(
    skillPath,
    "---\nname: delivery\ndescription: Native delivery regression\n---\nInspect the requested change.\n",
  );
  const sessionManager = native.SessionManager.create(directory, join(directory, "sessions"));
  const runtime = new native.ExtensionRuntime();
  const extensionRunner = extensionFactory
    ? new native.ExtensionRunner(
        [
          await native.loadExtensionFromFactory(
            extensionFactory,
            directory,
            new native.EventBus(),
            runtime,
          ),
        ],
        runtime,
        directory,
        sessionManager,
        registry,
        undefined,
        settings,
      )
    : undefined;
  const session = new native.AgentSession({
    agent,
    settings,
    modelRegistry: registry,
    sessionManager,
    ...(extensionRunner === undefined ? {} : { extensionRunner }),
    skills: [
      {
        name: "delivery",
        description: "Native delivery regression",
        filePath: skillPath,
        baseDir: directory,
        source: "test",
      },
    ],
    skillsSettings,
    memoryAgentDir: join(directory, "agent"),
    disableExtensionDiscovery: true,
  });
  try {
    await run(session, directory);
  } finally {
    session.beginDispose();
    agent.abort("Delivery test cleanup");
    for (const turn of turns) turn.release.resolve();
    try {
      await session.dispose();
    } finally {
      auth.close();
    }
  }
};

const png: ImageContent & { readonly mimeType: "image/png" } = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
};

const makeSender = (session: AgentSession) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return native.makeOmpPromptSender(
        session,
        yield* FileSystem.FileSystem,
        yield* Path.Path,
        yield* Crypto.Crypto,
        {
          chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001"),
          runEffect: Effect.runPromise,
        },
      );
    }).pipe(Effect.provide(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer))),
  );

const originalFile = (session: AgentSession) => {
  const sessionFile = session.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Delivery test requires a session file");
  const digest = createHash("sha256").update(Buffer.from(png.data, "base64")).digest("hex");
  return join(
    dirname(sessionFile),
    basename(sessionFile, extname(sessionFile)),
    "attachments",
    `${digest}.png`,
  );
};

const imageCount = (context: Context) =>
  context.messages.reduce((count, message) => {
    if (typeof message.content === "string") return count;
    return count + message.content.filter((part) => part.type === "image").length;
  }, 0);

describe("native OMP prompt delivery", () => {
  it("admits duplicate steers before the active submission completes and consumes each at its own turn", async () => {
    const first = providerTurn();
    const second = providerTurn();
    const third = providerTurn();
    await withSession([first, second, third], async (session) => {
      const initial = observeDelivery();
      let completed = false;
      const running = session
        .sendUserMessage("Initial prompt", { deliveryObserver: initial.observer })
        .then(() => {
          completed = true;
        });
      await first.entered.promise;
      expect(initial.events).toEqual(["prompt", "consumed"]);
      const a = observeDelivery();
      const b = observeDelivery();
      await session.sendUserMessage("Same text", { deliveryObserver: a.observer });
      await session.sendUserMessage("Same text", { deliveryObserver: b.observer });
      expect(a.events).toEqual(["steer"]);
      expect(b.events).toEqual(["steer"]);
      expect(completed).toBe(false);
      const [aMessage, bMessage] = session.agent.peekSteeringQueue();
      expect(aMessage).not.toBe(bMessage);
      first.release.resolve();
      const context = await second.entered.promise;
      expect(a.events).toEqual(["steer", "consumed"]);
      expect(b.events).toEqual(["steer"]);
      expect(
        context.messages.filter(
          (message) =>
            message.role === "user" &&
            (typeof message.content === "string"
              ? message.content === "Same text"
              : message.content.some((part) => part.type === "text" && part.text === "Same text")),
        ),
      ).toHaveLength(1);
      expect(completed).toBe(false);
      second.release.resolve();
      await third.entered.promise;
      expect(b.events).toEqual(["steer", "consumed"]);
      third.release.resolve();
      await running;
      expect(initial.events).toEqual(["prompt", "consumed"]);
    });
  }, 30_000);

  it("rechecks admission after concurrent idle preprocessing instead of rejecting the losing prompt", async () => {
    const first = providerTurn();
    await withSession([first], async (session) => {
      const a = observeDelivery();
      const b = observeDelivery();
      const left = session.sendUserMessage("First concurrent prompt", {
        deliveryObserver: a.observer,
      });
      const right = session.sendUserMessage("Second concurrent prompt", {
        deliveryObserver: b.observer,
      });
      const admissions = await Promise.all([a.accepted, b.accepted]);
      expect(admissions.toSorted()).toEqual(["prompt", "steer"]);
      await first.entered.promise;
      first.release.resolve();
      await Promise.all([left, right]);
      expect(await a.settled).toBe("consumed");
      expect(await b.settled).toBe("consumed");
    });
  }, 30_000);

  it("keeps delivery identity independent for equal image bytes", async () => {
    const first = providerTurn();
    const second = providerTurn();
    const third = providerTurn();
    await withSession([first, second, third], async (session) => {
      const running = session.sendUserMessage("Initial image run");
      await first.entered.promise;
      const a = observeDelivery();
      const b = observeDelivery();
      await session.prompt("Same image", {
        images: [png],
        streamingBehavior: "steer",
        deliveryObserver: a.observer,
      });
      await session.prompt("Same image", {
        images: [png],
        streamingBehavior: "steer",
        deliveryObserver: b.observer,
      });
      first.release.resolve();
      expect(imageCount(await second.entered.promise)).toBe(1);
      expect(a.events).toEqual(["steer", "consumed"]);
      expect(b.events).toEqual(["steer"]);
      second.release.resolve();
      expect(imageCount(await third.entered.promise)).toBe(2);
      expect(b.events).toEqual(["steer", "consumed"]);
      third.release.resolve();
      await running;
    });
  }, 30_000);

  it("discards only removed explicit queue entries and settles them once", async () => {
    await withSession([], async (session) => {
      const steer = observeDelivery();
      const followUp = observeDelivery();
      await session.runModeExitTeardown(async () => {
        await session.sendUserMessage("Follow-up", {
          deliverAs: "followUp",
          deliveryObserver: followUp.observer,
        });
        await session.sendUserMessage("Steer", {
          deliverAs: "steer",
          deliveryObserver: steer.observer,
        });
        expect(followUp.events).toEqual(["followUp"]);
        expect(steer.events).toEqual(["steer"]);
        session.popLastQueuedMessage();
        expect(steer.events).toEqual(["steer", "discarded"]);
        expect(followUp.events).toEqual(["followUp"]);
        session.clearQueue();
        session.clearQueue();
        session.beginDispose();
        expect(steer.events).toEqual(["steer", "discarded"]);
        expect(followUp.events).toEqual(["followUp", "discarded"]);
      });
    });
  }, 30_000);

  it("preserves an admitted steer across abort and mode teardown until native context insertion", async () => {
    const first = providerTurn();
    const second = providerTurn();
    await withSession([first, second], async (session) => {
      const running = session.sendUserMessage("Interrupted run");
      await first.entered.promise;
      const queued = observeDelivery();
      await session.sendUserMessage("Survives abort", { deliveryObserver: queued.observer });
      await session.runModeExitTeardown(async () => {
        await session.abort();
        expect(queued.events).toEqual(["steer"]);
      });
      await second.entered.promise;
      expect(queued.events).toEqual(["steer", "consumed"]);
      second.release.resolve();
      await running;
      await session.agent.waitForIdle();
    });
  }, 30_000);

  it("keeps temporarily removed switch queues live on rollback and discards them on a committed switch", async () => {
    await withSession([], async (session, directory) => {
      const otherCwd = join(directory, "other");
      await mkdir(otherCwd);
      const target = native.SessionManager.create(otherCwd, join(directory, "targets"));
      target.appendMessage({ role: "user", content: "Target history", timestamp: Date.now() });
      target.appendMessage(assistantMessage(session.model));
      await target.flush();
      const file = target.getSessionFile();
      if (!file) throw new Error("Switch target has no transcript");
      const queued = observeDelivery();
      await session.runModeExitTeardown(async () => {
        await session.sendUserMessage("Survives rejected switch", {
          deliverAs: "followUp",
          deliveryObserver: queued.observer,
        });
        const original = session.agent.peekFollowUpQueue()[0];
        expect(await session.switchSession(file, { onCwdChange: async () => false })).toBe(false);
        expect(session.agent.peekFollowUpQueue()[0]).toBe(original);
        expect(queued.events).toEqual(["followUp"]);
        expect(await session.switchSession(file, { onCwdChange: async () => true })).toBe(true);
        expect(queued.events).toEqual(["followUp", "discarded"]);
      });
    });
  }, 30_000);

  it("finalizes pending reset, new-session and close removals without admitting a closed-session prompt", async () => {
    await withSession([], async (session) => {
      const reset = observeDelivery();
      const renewed = observeDelivery();
      const closed = observeDelivery();
      const late = observeDelivery();
      await session.runModeExitTeardown(async () => {
        await session.sendUserMessage("Reset queue", {
          deliverAs: "steer",
          deliveryObserver: reset.observer,
        });
        await session.resetSessionContext();
        expect(reset.events).toEqual(["steer", "discarded"]);
        await session.sendUserMessage("New-session queue", {
          deliverAs: "followUp",
          deliveryObserver: renewed.observer,
        });
        await session.newSession();
        expect(renewed.events).toEqual(["followUp", "discarded"]);
        await session.sendUserMessage("Close queue", {
          deliverAs: "steer",
          deliveryObserver: closed.observer,
        });
        session.beginDispose();
        expect(closed.events).toEqual(["steer", "discarded"]);
        await session.sendUserMessage("Too late", { deliveryObserver: late.observer });
        expect(late.events).toEqual(["discarded"]);
        expect(session.agent.state.messages.some((message) => message.role === "user")).toBe(false);
      });
    });
  }, 30_000);

  it("observes a native skill-started run and the skill and ordinary messages steering it", async () => {
    const first = providerTurn();
    const second = providerTurn();
    const third = providerTurn();
    await withSession([first, second, third], async (session) => {
      const initial = observeDelivery();
      const skill = observeDelivery();
      const ordinary = observeDelivery();
      const running = native.tryRunRpcSkillCommand(
        session,
        "/skill:delivery initial",
        "steer",
        initial.observer,
      );
      await first.entered.promise;
      expect(initial.events).toEqual(["prompt", "consumed"]);
      await native.tryRunRpcSkillCommand(
        session,
        "/skill:delivery queued",
        "steer",
        skill.observer,
      );
      await session.sendUserMessage("Ordinary steer during skill", {
        deliveryObserver: ordinary.observer,
      });
      const queuedSkill = session.agent.peekSteeringQueue()[0];
      expect(queuedSkill).toMatchObject({
        role: "custom",
        customType: "skill-prompt",
        attribution: "user",
      });
      expect(skill.events).toEqual(["steer"]);
      first.release.resolve();
      await second.entered.promise;
      expect(skill.events).toEqual(["steer", "consumed"]);
      expect(ordinary.events).toEqual(["steer"]);
      second.release.resolve();
      await third.entered.promise;
      expect(ordinary.events).toEqual(["steer", "consumed"]);
      third.release.resolve();
      expect(await running).toEqual({ agentInvoked: true });
    });
  }, 30_000);

  it("shares one disposal and shutdown when flushed aside observers reenter close", async () => {
    const first = providerTurn();
    const second = providerTurn();
    const shutdownEntered = Promise.withResolvers<void>();
    const releaseShutdown = Promise.withResolvers<void>();
    let shutdownCount = 0;
    await withSession(
      [first, second],
      async (session) => {
        const running = session.sendUserMessage("Aside run");
        await first.entered.promise;
        const aside = observeDelivery();
        await session.sendUserMessage("Non-interrupting aside", {
          deliverAs: "aside",
          deliveryObserver: aside.observer,
        });
        expect(aside.events).toEqual(["aside"]);
        expect(session.agent.peekSteeringQueue()).toEqual([]);
        first.release.resolve();
        await second.entered.promise;
        expect(aside.events).toEqual(["aside", "consumed"]);
        const closing = observeDelivery();
        const following = observeDelivery();
        const consumedCounts: number[] = [];
        const reentrantDisposals: Promise<void>[] = [];
        const closingMessageCount = () =>
          session.agent.state.messages.filter(
            (message) =>
              message.role === "user" &&
              (typeof message.content === "string"
                ? message.content === "Close aside"
                : message.content.some(
                    (part) => part.type === "text" && part.text === "Close aside",
                  )),
          ).length;
        for (const delivery of [closing, following]) {
          await session.sendUserMessage("Close aside", {
            deliverAs: "aside",
            deliveryObserver: {
              ...delivery.observer,
              onConsumed: () => {
                consumedCounts.push(closingMessageCount());
                delivery.observer.onConsumed();
                reentrantDisposals.push(session.dispose());
              },
            },
          });
        }
        expect(closing.events).toEqual(["aside"]);
        expect(following.events).toEqual(["aside"]);
        expect(closingMessageCount()).toBe(0);
        const disposing = session.dispose();
        try {
          expect(session.isDisposed).toBe(true);
          expect(reentrantDisposals[0]).toBe(disposing);
          expect(reentrantDisposals[1]).toBe(disposing);
          expect(session.dispose()).toBe(disposing);
          session.beginDispose();
          expect(consumedCounts).toEqual([1, 2]);
          expect(closing.events).toEqual(["aside", "consumed"]);
          expect(following.events).toEqual(["aside", "consumed"]);
          expect(closingMessageCount()).toBe(2);
          await shutdownEntered.promise;
          expect(shutdownCount).toBe(1);
          second.release.resolve();
          await running;
          expect(closing.events).toEqual(["aside", "consumed"]);
          expect(following.events).toEqual(["aside", "consumed"]);
          expect(closingMessageCount()).toBe(2);
        } finally {
          releaseShutdown.resolve();
        }
        await disposing;
        expect(session.dispose()).toBe(disposing);
        expect(session.agent.state.messages).toEqual([]);
        expect(closing.events).toEqual(["aside", "consumed"]);
        expect(following.events).toEqual(["aside", "consumed"]);
      },
      (api) => {
        api.on("session_shutdown", async () => {
          shutdownCount++;
          shutdownEntered.resolve();
          await releaseShutdown.promise;
        });
      },
    );
    expect(shutdownCount).toBe(1);
  }, 30_000);

  it("distinguishes a locally handled command from a prompt dropped before native admission", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let handledCount = 0;
    await withSession(
      [],
      async (session) => {
        const handled = observeDelivery();
        expect(await session.prompt("/local-only", { deliveryObserver: handled.observer })).toBe(
          false,
        );
        expect(handled.events).toEqual([]);
        expect(handledCount).toBe(1);
        const dropped = observeDelivery();
        const running = session.sendUserMessage("Abort during prompt setup", {
          deliveryObserver: dropped.observer,
        });
        await entered.promise;
        const aborting = session.abort();
        release.resolve();
        await Promise.all([running, aborting]);
        expect(dropped.events).toEqual(["discarded"]);
        expect(session.agent.state.messages.some((message) => message.role === "user")).toBe(false);
      },
      (api) => {
        api.registerCommand("local-only", {
          handler: async () => {
            handledCount++;
          },
        });
        api.on("before_agent_start", async () => {
          entered.resolve();
          await release.promise;
        });
      },
    );
  }, 30_000);

  it("expands a known skill through the sender before reaching the provider", async () => {
    const turn = providerTurn();
    await withSession([turn], async (session) => {
      const live: Array<ReturnType<typeof native.normalizeTranscript>[number]> = [];
      const unsubscribe = session.subscribe((event) => {
        if (event.type !== "message_end") return;
        const normalized = native.normalizeAgentEvent(event);
        if (normalized?.type === "message-settled" && normalized.message.role === "user") {
          live.push(normalized.message);
        }
      });
      const send = await makeSender(session);
      const request = "Review the queued delivery change.";
      const input = `/skill:delivery ${request}`;
      const delivery = await send({ text: input, attachments: [] });
      if (delivery.kind !== "started")
        throw new Error("Expected the skill to start a provider turn");
      try {
        const context = await turn.entered.promise;
        const text = context.messages
          .filter((message) => message.role === "user")
          .flatMap((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content.flatMap((part) => (part.type === "text" ? part.text : [])),
          )
          .join("\n");
        expect(text).toContain("Inspect the requested change.");
        expect(text).toContain(request);
      } finally {
        turn.release.resolve();
        await Effect.runPromise(delivery.completed);
        unsubscribe();
      }
      await session.settleInFlightMessagePersistence();
      await session.sessionManager.ensureOnDisk();
      await session.sessionManager.flush();
      const file = session.sessionManager.getSessionFile();
      if (file === undefined) throw new Error("Expected skill journal");
      const persisted = native.normalizeTranscript(await native.loadSessionMessagesReadOnly(file));
      expect(live.map((message) => message.content)).toEqual([[{ type: "text", text: input }]]);
      expect(persisted.filter((message) => message.role === "user")).toEqual(live);
    });
  }, 30_000);

  it.each([
    {
      name: "ordinary text",
      text: "Review the queued delivery change.",
      enableSkillCommands: true,
    },
    {
      name: "an unknown skill",
      text: "/skill:missing Review the queued delivery change.",
      enableSkillCommands: true,
    },
    {
      name: "a disabled known skill",
      text: "/skill:delivery Review the queued delivery change.",
      enableSkillCommands: false,
    },
  ])(
    "delivers $name literally through the sender",
    async ({ text: input, enableSkillCommands }) => {
      const turn = providerTurn();
      await withSession(
        [turn],
        async (session) => {
          const send = await makeSender(session);
          const delivery = await send({ text: input, attachments: [] });
          if (delivery.kind !== "started")
            throw new Error("Expected text to start a provider turn");
          try {
            const context = await turn.entered.promise;
            const text = context.messages
              .filter((message) => message.role === "user")
              .flatMap((message) =>
                typeof message.content === "string"
                  ? message.content
                  : message.content.flatMap((part) => (part.type === "text" ? part.text : [])),
              )
              .join("\n");
            expect(text).toBe(input);
          } finally {
            turn.release.resolve();
            await Effect.runPromise(delivery.completed);
          }
        },
        undefined,
        { enableSkillCommands },
      );
    },
    30_000,
  );

  it("rejects sender admission when an idle native image prompt is discarded before dispatch", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await withSession(
      [],
      async (session) => {
        const send = await makeSender(session);
        const agentEvents: string[] = [];
        let started = 0;
        session.subscribe((event) => {
          if (event.type === "agent_start" || event.type === "agent_end") {
            agentEvents.push(event.type);
          }
        });
        const sending = send(
          { text: "Discard before dispatch", attachments: [{ ...png, name: "idle.png" }] },
          () => {
            started++;
          },
        ).then(
          (delivery) => delivery,
          (error: unknown) => error,
        );
        try {
          await entered.promise;
          expect(started).toBe(0);
          expect(await readFile(originalFile(session))).toEqual(Buffer.from(png.data, "base64"));
          const aborting = session.abort();
          release.resolve();
          const [result] = await Promise.all([sending, aborting]);
          expect(result).toBeInstanceOf(AgentError);
          expect(started).toBe(0);
          expect(agentEvents).toEqual([]);
          expect(session.messages.some((message) => message.role === "user")).toBe(false);
          expect(await Bun.file(originalFile(session)).exists()).toBe(false);
        } finally {
          release.resolve();
        }
      },
      (api) => {
        api.on("before_agent_start", async () => {
          entered.resolve();
          await release.promise;
        });
      },
    );
  }, 30_000);

  it("removes shared originals after the last native image steer is discarded", async () => {
    const first = providerTurn();
    await withSession([first], async (session) => {
      const running = session.sendUserMessage("Hold the provider open");
      await first.entered.promise;
      const send = await makeSender(session);
      const input = { text: "Queued image", attachments: [{ ...png, name: "queued.png" }] };
      const creator = await send(input);
      const duplicate = await send(input);
      if (creator.kind !== "steered" || duplicate.kind !== "steered") {
        throw new Error("Both image prompts must join the native queue");
      }
      await Effect.runPromise(Effect.all([creator.completed, duplicate.completed]));
      const file = originalFile(session);
      session.popLastQueuedMessage();
      expect(await Effect.runPromise(duplicate.consumed)).toBe("discarded");
      expect(await readFile(file)).toEqual(Buffer.from(png.data, "base64"));
      session.clearQueue();
      expect(await Effect.runPromise(creator.consumed)).toBe("discarded");
      expect(await Bun.file(file).exists()).toBe(false);
      first.release.resolve();
      await running;
    });
  }, 30_000);

  it("retains a shared original consumed by a later native message when its creator is discarded", async () => {
    const first = providerTurn();
    const second = providerTurn();
    await withSession([first, second], async (session) => {
      const running = session.sendUserMessage("Hold the provider open");
      await first.entered.promise;
      const send = await makeSender(session);
      const input = { text: "Shared image", attachments: [{ ...png, name: "shared.png" }] };
      const creator = await send(input);
      const duplicate = await send(input);
      if (creator.kind !== "steered" || duplicate.kind !== "steered") {
        throw new Error("Both image prompts must join the native queue");
      }
      await Effect.runPromise(Effect.all([creator.completed, duplicate.completed]));
      const [creatorMessage, duplicateMessage] = session.agent.peekSteeringQueue();
      if (!creatorMessage || !duplicateMessage)
        throw new Error("Missing native image queue entries");
      session.agent.replaceQueues([duplicateMessage, creatorMessage], []);
      first.release.resolve();
      expect(imageCount(await second.entered.promise)).toBe(1);
      expect(await Effect.runPromise(duplicate.consumed)).toBe("consumed");
      session.popLastQueuedMessage();
      expect(await Effect.runPromise(creator.consumed)).toBe("discarded");
      expect(await readFile(originalFile(session))).toEqual(Buffer.from(png.data, "base64"));
      second.release.resolve();
      await running;
    });
  }, 30_000);
});
