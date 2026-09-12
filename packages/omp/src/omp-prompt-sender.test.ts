import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type { tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type * as OmpAgentSession from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { PromptDeliveryObserver } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import * as AgentMessage from "@pico/contract/agent-message";
import * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { makeOmpPromptSender } from "./omp-prompt-sender.ts";

type HelperSession = Parameters<typeof tryRunRpcSkillCommand>[0];
type Skill = HelperSession["skills"][number];
type CustomMessage = Parameters<HelperSession["promptCustomMessage"]>[0];
type CustomMessageOptions = Parameters<HelperSession["promptCustomMessage"]>[1];
type LiteralPrompt = Parameters<OmpAgentSession.AgentSession["sendUserMessage"]>[0];
type ImagePromptOptions = Parameters<OmpAgentSession.AgentSession["prompt"]>[1];
type LiteralPromptOptions = Parameters<OmpAgentSession.AgentSession["sendUserMessage"]>[1];

const platformLayer = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);
const textPrompt = (text: string) => AgentMessage.AgentPrompt.make({ text, attachments: [] });
const diagnostics = {
  chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001"),
  runEffect: Effect.runPromise,
};
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const gifBase64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const makeFakeSession = (
  skill: Skill,
  enableSkillCommands: boolean,
  sessionFile: string,
  accepted = true,
  promptGate?: (call: number) => Promise<void>,
) => {
  const customMessages: Array<{
    readonly message: CustomMessage;
    readonly options: CustomMessageOptions;
  }> = [];
  const literalPrompts: Array<LiteralPrompt> = [];
  const imagePrompts: Array<{ readonly text: string; readonly options: ImagePromptOptions }> = [];
  const session = {
    skillsSettings: { enableSkillCommands },
    skills: [skill],
    sessionManager: { getSessionFile: () => sessionFile },
    promptCustomMessage: (message: CustomMessage, options?: CustomMessageOptions) => {
      customMessages.push({ message, options });
      options?.deliveryObserver?.onAccepted("prompt");
      options?.deliveryObserver?.onConsumed();
      return Promise.resolve(true);
    },
    sendUserMessage: (prompt: LiteralPrompt, options?: LiteralPromptOptions) => {
      literalPrompts.push(prompt);
      options?.deliveryObserver?.onAccepted("prompt");
      options?.deliveryObserver?.onConsumed();
      return Promise.resolve();
    },
    prompt: async (text: string, options?: ImagePromptOptions) => {
      imagePrompts.push({ text, options });
      await promptGate?.(imagePrompts.length);
      if (!accepted) {
        options?.deliveryObserver?.onDiscarded();
      } else {
        options?.deliveryObserver?.onAccepted("prompt");
        options?.deliveryObserver?.onConsumed();
      }
      return true;
    },
  };
  return { session, customMessages, literalPrompts, imagePrompts };
};

describe("makeOmpPromptSender", () => {
  it.effect(
    "admits duplicate images before completion and retains accepted originals after failure",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-image-admission-" });
        const fake = makeFakeSession(
          {
            name: "unused",
            description: "unused",
            filePath: path.join(root, "SKILL.md"),
            baseDir: root,
            source: "test",
          },
          false,
          path.join(root, "chat.jsonl"),
        );
        const firstOperation = Promise.withResolvers<void>();
        const observers: PromptDeliveryObserver[] = [];
        fake.session.prompt = async (_text, options) => {
          const observer = options?.deliveryObserver;
          if (observer === undefined) throw new Error("Missing prompt delivery observer");
          observers.push(observer);
          observer.onAccepted(observers.length === 1 ? "prompt" : "steer");
          if (observers.length === 1) {
            observer.onConsumed();
            await firstOperation.promise;
          }
          return true;
        };
        const send = makeOmpPromptSender(fake.session, fileSystem, path, crypto, diagnostics);
        const input = AgentMessage.AgentPrompt.make({
          text: "same",
          attachments: [
            { type: "image", name: "same.png", data: pngBase64, mimeType: "image/png" },
          ],
        });
        const first = yield* Effect.promise(() => send(input));
        const second = yield* Effect.promise(() => send(input));
        const third = yield* Effect.promise(() => send(input));
        if (first.kind !== "started" || second.kind !== "steered" || third.kind !== "steered") {
          return yield* Effect.die("Unexpected delivery kinds");
        }
        const thirdConsumed = yield* Deferred.make<void>();
        const thirdResult = yield* third.consumed.pipe(
          Effect.tap(() => Deferred.succeed(thirdConsumed, undefined)),
          Effect.forkChild,
        );
        observers[1]?.onConsumed();
        assert.strictEqual(yield* second.consumed, "consumed");
        assert.isFalse(yield* Deferred.isDone(thirdConsumed));
        observers[2]?.onDiscarded();
        assert.strictEqual(yield* Fiber.join(thirdResult), "discarded");
        firstOperation.reject(new Error("provider failed after admission"));
        assert.instanceOf(yield* first.completed.pipe(Effect.flip), AgentError);
        const image = new Uint8Array(Buffer.from(pngBase64, "base64"));
        const digest = hex(yield* crypto.digest("SHA-256", image));
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(root, "chat", "attachments", `${digest}.png`)),
          image,
        );
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("preserves text and skill prompt behavior", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const skillDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-omp-skill-",
      });
      const sessionFile = path.join(skillDirectory, "session.jsonl");
      const skillFile = path.join(skillDirectory, "SKILL.md");
      yield* fileSystem.writeFileString(
        skillFile,
        "---\nname: focused-skill\ndescription: Focused adapter test\n---\nFollow the focused instructions.\nPreserve the supplied arguments.\n",
      );
      const skill = {
        name: "focused-skill",
        description: "Focused adapter test",
        filePath: skillFile,
        baseDir: skillDirectory,
        source: "test",
      } satisfies Skill;

      const enabled = makeFakeSession(skill, true, sessionFile);
      yield* Effect.promise(() =>
        makeOmpPromptSender(
          enabled.session,
          fileSystem,
          path,
          crypto,
          diagnostics,
        )(textPrompt("/skill:focused-skill inspect auth")),
      );
      assert.deepStrictEqual(enabled.literalPrompts, []);
      assert.deepStrictEqual(enabled.imagePrompts, []);
      assert.deepStrictEqual(
        enabled.customMessages.map(({ message, options }) => ({
          customType: message.customType,
          display: message.display,
          details: message.details,
          attribution: message.attribution,
          options: { streamingBehavior: options?.streamingBehavior },
        })),
        [
          {
            customType: "skill-prompt",
            display: true,
            details: {
              name: "focused-skill",
              path: skillFile,
              args: "inspect auth",
              lineCount: 2,
            },
            attribution: "user",
            options: { streamingBehavior: "steer" },
          },
        ],
      );

      const ordinary = makeFakeSession(skill, true, sessionFile);
      yield* Effect.promise(() =>
        makeOmpPromptSender(
          ordinary.session,
          fileSystem,
          path,
          crypto,
          diagnostics,
        )(textPrompt("  ordinary text stays exact  ")),
      );
      assert.deepStrictEqual(ordinary.literalPrompts, ["  ordinary text stays exact  "]);
      assert.deepStrictEqual(ordinary.customMessages, []);

      const unknown = makeFakeSession(skill, true, sessionFile);
      yield* Effect.promise(() =>
        makeOmpPromptSender(
          unknown.session,
          fileSystem,
          path,
          crypto,
          diagnostics,
        )(textPrompt("/skill:unknown keep this exact")),
      );
      assert.deepStrictEqual(unknown.literalPrompts, ["/skill:unknown keep this exact"]);

      const disabled = makeFakeSession(skill, false, sessionFile);
      yield* Effect.promise(() =>
        makeOmpPromptSender(
          disabled.session,
          fileSystem,
          path,
          crypto,
          diagnostics,
        )(textPrompt("/skill:focused-skill still literal")),
      );
      assert.deepStrictEqual(disabled.literalPrompts, ["/skill:focused-skill still literal"]);

      const missingSkill = {
        ...skill,
        filePath: path.join(skillDirectory, "missing", "SKILL.md"),
      } satisfies Skill;
      const rejected = makeFakeSession(missingSkill, true, sessionFile);
      const rejection = yield* Effect.tryPromise({
        try: () =>
          makeOmpPromptSender(
            rejected.session,
            fileSystem,
            path,
            crypto,
            diagnostics,
          )(textPrompt("/skill:focused-skill cannot build")),
        catch: (error) => error,
      }).pipe(Effect.flip);
      assert.instanceOf(rejection, Error);
      assert.deepStrictEqual(rejected.literalPrompts, []);
      assert.deepStrictEqual(rejected.customMessages, []);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("persists ordered originals and submits image prompts through OMP once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-omp-images-" });
      const sessionFile = path.join(root, "chat.jsonl");
      const skill = {
        name: "focused-skill",
        description: "Focused adapter test",
        filePath: path.join(root, "SKILL.md"),
        baseDir: root,
        source: "test",
      } satisfies Skill;
      const png = Uint8Array.from(Buffer.from(pngBase64, "base64"));
      const gif = Uint8Array.from(Buffer.from(gifBase64, "base64"));
      const prompt = AgentMessage.AgentPrompt.make({
        text: "",
        attachments: [
          {
            type: "image",
            name: "first.png",
            data: Buffer.from(png).toString("base64"),
            mimeType: "image/png",
          },
          {
            type: "image",
            name: "second.gif",
            data: Buffer.from(gif).toString("base64"),
            mimeType: "image/gif",
          },
        ],
      });
      const fake = makeFakeSession(skill, true, sessionFile);
      yield* Effect.promise(() =>
        makeOmpPromptSender(fake.session, fileSystem, path, crypto, diagnostics)(prompt),
      );

      assert.deepStrictEqual(fake.literalPrompts, []);
      assert.deepStrictEqual(fake.customMessages, []);
      assert.strictEqual(fake.imagePrompts.length, 1);
      const call = fake.imagePrompts[0];
      if (call === undefined) return yield* Effect.die("missing image prompt call");
      assert.deepStrictEqual(
        {
          images: call.options?.images,
          expandPromptTemplates: call.options?.expandPromptTemplates,
          streamingBehavior: call.options?.streamingBehavior,
        },
        {
          images: prompt.attachments.map(({ data, mimeType }) => ({
            type: "image",
            data,
            mimeType,
          })),
          expandPromptTemplates: false,
          streamingBehavior: "steer",
        } satisfies NonNullable<ImagePromptOptions>,
      );

      const attachmentsDirectory = path.join(root, "chat", "attachments");
      const pngFile = path.join(
        attachmentsDirectory,
        `${hex(yield* crypto.digest("SHA-256", png))}.png`,
      );
      const gifFile = path.join(
        attachmentsDirectory,
        `${hex(yield* crypto.digest("SHA-256", gif))}.gif`,
      );
      assert.deepStrictEqual(yield* fileSystem.readFile(pngFile), png);
      assert.deepStrictEqual(yield* fileSystem.readFile(gifFile), gif);
      assert.include(call.text, `- "first.png": ${JSON.stringify(pngFile)}`);
      assert.include(call.text, `- "second.gif": ${JSON.stringify(gifFile)}`);
      assert.isTrue(call.text.indexOf("first.png") < call.text.indexOf("second.gif"));

      const firstAttachment = prompt.attachments[0];
      if (firstAttachment === undefined) return yield* Effect.die("missing first attachment");

      const skillWithImage = makeFakeSession(skill, true, path.join(root, "skill-image.jsonl"));
      yield* Effect.promise(() =>
        makeOmpPromptSender(
          skillWithImage.session,
          fileSystem,
          path,
          crypto,
          diagnostics,
        )(
          AgentMessage.AgentPrompt.make({
            text: "/skill:focused-skill keep the image",
            attachments: [firstAttachment],
          }),
        ),
      );
      assert.deepStrictEqual(skillWithImage.customMessages, []);
      assert.strictEqual(skillWithImage.imagePrompts.length, 1);
      assert.include(
        skillWithImage.imagePrompts[0]?.text ?? "",
        "/skill:focused-skill keep the image",
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("removes newly written originals when OMP rejects the prompt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-omp-rollback-" });
      const sessionFile = path.join(root, "chat.jsonl");
      const skill = {
        name: "focused-skill",
        description: "Focused adapter test",
        filePath: path.join(root, "SKILL.md"),
        baseDir: root,
        source: "test",
      } satisfies Skill;
      const rejected = makeFakeSession(skill, true, sessionFile, false);
      const failure = yield* Effect.tryPromise({
        try: () =>
          makeOmpPromptSender(
            rejected.session,
            fileSystem,
            path,
            crypto,
            diagnostics,
          )(
            AgentMessage.AgentPrompt.make({
              text: "image",
              attachments: [
                {
                  type: "image",
                  name: "rollback.png",
                  data: pngBase64,
                  mimeType: "image/png",
                },
              ],
            }),
          ),
        catch: (error) => error,
      }).pipe(Effect.flip);
      assert.instanceOf(failure, AgentError);
      assert.isFalse(yield* fileSystem.exists(path.join(root, "chat")));
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("rejects malformed or mislabeled images before persistence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-omp-invalid-" });
      const sessionFile = path.join(root, "chat.jsonl");
      const skill = {
        name: "focused-skill",
        description: "Focused adapter test",
        filePath: path.join(root, "SKILL.md"),
        baseDir: root,
        source: "test",
      } satisfies Skill;
      const fake = makeFakeSession(skill, true, sessionFile);
      const send = makeOmpPromptSender(fake.session, fileSystem, path, crypto, diagnostics);

      for (const attachment of [
        { type: "image", name: "fake.png", data: "bm90IGFuIGltYWdl", mimeType: "image/png" },
        { type: "image", name: "mislabeled.webp", data: pngBase64, mimeType: "image/webp" },
      ] satisfies ReadonlyArray<AgentMessage.AgentImageAttachment>) {
        const failure = yield* Effect.tryPromise({
          try: () => send({ text: "inspect", attachments: [attachment] }),
          catch: (error) => error,
        }).pipe(Effect.flip);
        assert.instanceOf(failure, Error);
      }

      assert.deepStrictEqual(fake.imagePrompts, []);
      assert.isFalse(yield* fileSystem.exists(path.join(root, "chat")));
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("rejects out-of-contract prompts before writing originals", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-omp-limit-" });
      const sessionFile = path.join(root, "chat.jsonl");
      const skill = {
        name: "focused-skill",
        description: "Focused adapter test",
        filePath: path.join(root, "SKILL.md"),
        baseDir: root,
        source: "test",
      } satisfies Skill;
      const fake = makeFakeSession(skill, true, sessionFile);
      const attachment: AgentMessage.AgentImageAttachment = {
        type: "image",
        name: "tiny.png",
        data: "aQ==",
        mimeType: "image/png",
      };
      const invalidPrompt: AgentMessage.AgentPrompt = {
        text: "",
        attachments: Array.from(
          { length: AgentMessage.MAX_AGENT_IMAGE_ATTACHMENTS + 1 },
          () => attachment,
        ),
      };

      const failure = yield* Effect.tryPromise({
        try: () =>
          makeOmpPromptSender(fake.session, fileSystem, path, crypto, diagnostics)(invalidPrompt),
        catch: (error) => error,
      }).pipe(Effect.flip);

      assert.instanceOf(failure, Error);
      assert.deepStrictEqual(fake.imagePrompts, []);
      assert.isFalse(yield* fileSystem.exists(path.join(root, "chat")));
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("serializes prompt acceptance and attachment cleanup per session", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-omp-serial-" });
      const sessionFile = path.join(root, "chat.jsonl");
      const firstStarted = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const skill = {
        name: "focused-skill",
        description: "Focused adapter test",
        filePath: path.join(root, "SKILL.md"),
        baseDir: root,
        source: "test",
      } satisfies Skill;
      const fake = makeFakeSession(skill, true, sessionFile, true, async (call) => {
        if (call !== 1) return;
        firstStarted.resolve();
        await releaseFirst.promise;
      });
      const send = makeOmpPromptSender(fake.session, fileSystem, path, crypto, diagnostics);
      const attachment = (name: string): AgentMessage.AgentImageAttachment => ({
        type: "image",
        name,
        data: pngBase64,
        mimeType: "image/png",
      });

      const first = send({ text: "first", attachments: [attachment("first")] });
      yield* Effect.promise(() => firstStarted.promise);
      const second = send({ text: "second", attachments: [attachment("second")] });
      yield* Effect.promise(() => Promise.resolve());
      assert.strictEqual(fake.imagePrompts.length, 1);

      releaseFirst.resolve();
      yield* Effect.promise(() => Promise.all([first, second]));
      assert.deepStrictEqual(
        fake.imagePrompts.map(({ text }) => text.split("\n", 1)[0]),
        ["first", "second"],
      );
    }).pipe(Effect.provide(platformLayer)),
  );
  it.effect("reports failed image rollback without replacing the rejected prompt", () => {
    const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const runEffect = Effect.runPromiseWith(yield* Effect.context<never>());
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-omp-rollback-failure-",
      });
      const primary = new Error("private prompt rejection");
      const fake = makeFakeSession(
        {
          name: "focused-skill",
          description: "Focused adapter test",
          filePath: path.join(root, "SKILL.md"),
          baseDir: root,
          source: "test",
        },
        true,
        path.join(root, "chat.jsonl"),
        true,
        async () => {
          throw primary;
        },
      );
      const failingCleanup = FileSystem.FileSystem.of({
        ...fileSystem,
        remove: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "remove",
              description: "private filesystem details",
            }),
          ),
      });
      const failure = yield* Effect.tryPromise({
        try: () =>
          makeOmpPromptSender(fake.session, failingCleanup, path, crypto, {
            ...diagnostics,
            runEffect,
          })({
            text: "private prompt",
            attachments: [
              {
                type: "image",
                name: "private filename.png",
                data: pngBase64,
                mimeType: "image/png",
              },
            ],
          }),
        catch: (error) => error,
      }).pipe(Effect.flip);
      assert.strictEqual(failure, primary);
      const errors = records.filter((record) => record.level === "ERROR");
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0]?.annotations.chatId, diagnostics.chatId);
      assert.strictEqual(errors[0]?.annotations.phase, "prompt-rollback");
      assert.notInclude(JSON.stringify(records), "private");
      assert.isTrue(yield* fileSystem.exists(path.join(root, "chat", "attachments")));
    }).pipe(
      Effect.provide(platformLayer),
      Effect.provide(
        Logger.layer([
          Logger.make((options) => records.push(Logger.formatStructured.log(options))),
        ]),
      ),
    );
  });

  it.effect("retains an original when its creator is discarded during another admission", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-omp-shared-admission-",
      });
      const secondWriteEntered = Promise.withResolvers<void>();
      const releaseSecondWrite = Promise.withResolvers<void>();
      const releaseRemoval = Promise.withResolvers<void>();
      let writes = 0;
      const gatedFiles = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFile: (file, bytes, options) => {
          const writing = fileSystem.writeFile(file, bytes, options);
          if (++writes !== 2) return writing;
          return writing.pipe(
            Effect.ensuring(
              Effect.promise(async () => {
                secondWriteEntered.resolve();
                await releaseSecondWrite.promise;
              }),
            ),
          );
        },
        remove: (file, options) =>
          Effect.promise(() => releaseRemoval.promise).pipe(
            Effect.andThen(fileSystem.remove(file, options)),
          ),
      });
      const fake = makeFakeSession(
        {
          name: "unused",
          description: "unused",
          filePath: path.join(root, "SKILL.md"),
          baseDir: root,
          source: "test",
        },
        false,
        path.join(root, "chat.jsonl"),
      );
      const observers: PromptDeliveryObserver[] = [];
      fake.session.prompt = async (_text, options) => {
        const observer = options?.deliveryObserver;
        if (!observer) throw new Error("Missing prompt delivery observer");
        observers.push(observer);
        observer.onAccepted("steer");
        return true;
      };
      const send = makeOmpPromptSender(fake.session, gatedFiles, path, crypto, diagnostics);
      const input = AgentMessage.AgentPrompt.make({
        text: "Shared image",
        attachments: [
          { type: "image", name: "shared.png", data: pngBase64, mimeType: "image/png" },
        ],
      });
      try {
        const creator = yield* Effect.promise(() => send(input));
        if (creator.kind !== "steered") return yield* Effect.die("Creator must queue");
        yield* creator.completed;
        const admitting = send(input);
        yield* Effect.promise(() => secondWriteEntered.promise);
        const creatorObserver = observers[0];
        if (!creatorObserver) return yield* Effect.die("Missing creator observer");
        creatorObserver.onDiscarded();
        releaseSecondWrite.resolve();
        const duplicate = yield* Effect.promise(() => admitting);
        if (duplicate.kind !== "steered") return yield* Effect.die("Duplicate must queue");
        const duplicateObserver = observers[1];
        if (!duplicateObserver) return yield* Effect.die("Missing duplicate observer");
        duplicateObserver.onConsumed();
        releaseRemoval.resolve();
        assert.strictEqual(yield* creator.consumed, "discarded");
        assert.strictEqual(yield* duplicate.consumed, "consumed");
        const image = new Uint8Array(Buffer.from(pngBase64, "base64"));
        const digest = hex(yield* crypto.digest("SHA-256", image));
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(root, "chat", "attachments", `${digest}.png`)),
          image,
        );
      } finally {
        releaseSecondWrite.resolve();
        releaseRemoval.resolve();
      }
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("reports one late image cleanup failure without rejecting discarded delivery", () => {
    const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const runEffect = Effect.runPromiseWith(yield* Effect.context<never>());
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-omp-late-rollback-failure-",
      });
      const fake = makeFakeSession(
        {
          name: "unused",
          description: "unused",
          filePath: path.join(root, "SKILL.md"),
          baseDir: root,
          source: "test",
        },
        false,
        path.join(root, "chat.jsonl"),
      );
      const queued = Promise.withResolvers<PromptDeliveryObserver>();
      fake.session.prompt = async (_text, options) => {
        const observer = options?.deliveryObserver;
        if (!observer) throw new Error("Missing prompt delivery observer");
        queued.resolve(observer);
        observer.onAccepted("steer");
        return true;
      };
      const failingCleanup = FileSystem.FileSystem.of({
        ...fileSystem,
        remove: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "remove",
              description: "private filesystem details",
            }),
          ),
      });
      const send = makeOmpPromptSender(fake.session, failingCleanup, path, crypto, {
        ...diagnostics,
        runEffect,
      });
      const delivery = yield* Effect.promise(() =>
        send({
          text: "private queued prompt",
          attachments: [
            {
              type: "image",
              name: "private filename.png",
              data: pngBase64,
              mimeType: "image/png",
            },
          ],
        }),
      );
      if (delivery.kind !== "steered") return yield* Effect.die("Image prompt must queue");
      yield* delivery.completed;
      const observer = yield* Effect.promise(() => queued.promise);
      observer.onDiscarded();
      observer.onDiscarded();
      assert.strictEqual(yield* delivery.consumed, "discarded");
      const errors = records.filter((record) => record.level === "ERROR");
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0]?.annotations.chatId, diagnostics.chatId);
      assert.strictEqual(errors[0]?.annotations.phase, "prompt-rollback");
      assert.notInclude(JSON.stringify(records), "private");
      assert.isTrue(yield* fileSystem.exists(path.join(root, "chat", "attachments")));
    }).pipe(
      Effect.provide(platformLayer),
      Effect.provide(
        Logger.layer([
          Logger.make((options) => records.push(Logger.formatStructured.log(options))),
        ]),
      ),
    );
  });
});
