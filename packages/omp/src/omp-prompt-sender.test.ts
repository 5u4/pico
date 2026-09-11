import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type { tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type * as OmpAgentSession from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as AgentMessage from "@pico/contract/agent-message";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { makeOmpPromptSender } from "./omp-prompt-sender.ts";

type HelperSession = Parameters<typeof tryRunRpcSkillCommand>[0];
type Skill = HelperSession["skills"][number];
type CustomMessage = Parameters<HelperSession["promptCustomMessage"]>[0];
type CustomMessageOptions = Parameters<HelperSession["promptCustomMessage"]>[1];
type LiteralPrompt = Parameters<OmpAgentSession.AgentSession["sendUserMessage"]>[0];
type ImagePromptOptions = Parameters<OmpAgentSession.AgentSession["prompt"]>[1];
type PromptDropped = Parameters<OmpAgentSession.AgentSession["setPromptDropped"]>[0];

const platformLayer = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);
const textPrompt = (text: string) => AgentMessage.AgentPrompt.make({ text, attachments: [] });
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const makeFakeSession = (
  skill: Skill,
  enableSkillCommands: boolean,
  sessionFile: string,
  accepted = true,
) => {
  const customMessages: Array<{
    readonly message: CustomMessage;
    readonly options: CustomMessageOptions;
  }> = [];
  const literalPrompts: Array<LiteralPrompt> = [];
  const imagePrompts: Array<{ readonly text: string; readonly options: ImagePromptOptions }> = [];
  let promptDropped: PromptDropped;
  const session = {
    skillsSettings: { enableSkillCommands },
    skills: [skill],
    sessionManager: { getSessionFile: () => sessionFile },
    promptCustomMessage: (message: CustomMessage, options?: CustomMessageOptions) => {
      customMessages.push({ message, options });
      return Promise.resolve();
    },
    sendUserMessage: (prompt: LiteralPrompt) => {
      literalPrompts.push(prompt);
      return Promise.resolve();
    },
    setPromptDropped: (handler: PromptDropped) => {
      promptDropped = handler;
    },
    prompt: (text: string, options?: ImagePromptOptions) => {
      imagePrompts.push({ text, options });
      if (!accepted) {
        promptDropped?.({ text, ...(options?.images ? { images: options.images } : {}) });
      }
      return Promise.resolve(true);
    },
  };
  return { session, customMessages, literalPrompts, imagePrompts };
};

describe("makeOmpPromptSender", () => {
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
          options,
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
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 5]);
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
        makeOmpPromptSender(fake.session, fileSystem, path, crypto)(prompt),
      );

      assert.deepStrictEqual(fake.literalPrompts, []);
      assert.deepStrictEqual(fake.customMessages, []);
      assert.strictEqual(fake.imagePrompts.length, 1);
      const call = fake.imagePrompts[0];
      if (call === undefined) return yield* Effect.die("missing image prompt call");
      assert.deepStrictEqual(call.options, {
        images: prompt.attachments.map(({ data, mimeType }) => ({
          type: "image",
          data,
          mimeType,
        })),
        expandPromptTemplates: false,
        streamingBehavior: "steer",
      } satisfies NonNullable<ImagePromptOptions>);

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
          )(
            AgentMessage.AgentPrompt.make({
              text: "image",
              attachments: [
                {
                  type: "image",
                  name: "rollback.webp",
                  data: Buffer.from("rollback").toString("base64"),
                  mimeType: "image/webp",
                },
              ],
            }),
          ),
        catch: (error) => error,
      }).pipe(Effect.flip);
      assert.instanceOf(failure, Error);
      assert.isFalse(yield* fileSystem.exists(path.join(root, "chat")));
    }).pipe(Effect.provide(platformLayer)),
  );
});
