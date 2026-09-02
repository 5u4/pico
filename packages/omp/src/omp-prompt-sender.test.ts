import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type { tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type * as OmpAgentSession from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as AgentMessage from "@pico/contract/agent-message";
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

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const makeFakeSession = (skill: Skill, enableSkillCommands: boolean) => {
  const customMessages: Array<{
    readonly message: CustomMessage;
    readonly options: CustomMessageOptions;
  }> = [];
  const literalPrompts: Array<LiteralPrompt> = [];
  const session = {
    skillsSettings: { enableSkillCommands },
    skills: [skill],
    promptCustomMessage: (message: CustomMessage, options?: CustomMessageOptions) => {
      customMessages.push({ message, options });
      return Promise.resolve();
    },
    sendUserMessage: (prompt: LiteralPrompt) => {
      literalPrompts.push(prompt);
      return Promise.resolve();
    },
  };
  return { session, customMessages, literalPrompts };
};

describe("makeOmpPromptSender", () => {
  it.effect("dispatches skills first and only falls back for an explicit miss", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const skillDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-omp-skill-",
      });
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

      const enabled = makeFakeSession(skill, true);
      const sendEnabled = makeOmpPromptSender(enabled.session);
      yield* Effect.promise(() =>
        sendEnabled(AgentMessage.AgentPrompt.make("/skill:focused-skill inspect auth")),
      );
      assert.deepStrictEqual(enabled.literalPrompts, []);
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
      assert.include(
        enabled.customMessages.map(({ message }) => message.content).join("\n"),
        "Follow the focused instructions.",
      );

      const ordinary = makeFakeSession(skill, true);
      const ordinaryPrompt = AgentMessage.AgentPrompt.make("  ordinary text stays exact  ");
      yield* Effect.promise(() => makeOmpPromptSender(ordinary.session)(ordinaryPrompt));
      assert.deepStrictEqual(ordinary.literalPrompts, [ordinaryPrompt]);
      assert.deepStrictEqual(ordinary.customMessages, []);

      const unknown = makeFakeSession(skill, true);
      const unknownPrompt = AgentMessage.AgentPrompt.make("/skill:unknown keep this exact");
      yield* Effect.promise(() => makeOmpPromptSender(unknown.session)(unknownPrompt));
      assert.deepStrictEqual(unknown.literalPrompts, [unknownPrompt]);
      assert.deepStrictEqual(unknown.customMessages, []);

      const disabled = makeFakeSession(skill, false);
      const disabledPrompt = AgentMessage.AgentPrompt.make("/skill:focused-skill still literal");
      yield* Effect.promise(() => makeOmpPromptSender(disabled.session)(disabledPrompt));
      assert.deepStrictEqual(disabled.literalPrompts, [disabledPrompt]);
      assert.deepStrictEqual(disabled.customMessages, []);

      const missingSkill = {
        ...skill,
        filePath: path.join(skillDirectory, "missing", "SKILL.md"),
      } satisfies Skill;
      const rejected = makeFakeSession(missingSkill, true);
      const rejection = yield* Effect.tryPromise({
        try: () =>
          makeOmpPromptSender(rejected.session)(
            AgentMessage.AgentPrompt.make("/skill:focused-skill cannot build"),
          ),
        catch: (error) => error,
      }).pipe(Effect.flip);
      assert.instanceOf(rejection, Error);
      assert.deepStrictEqual(rejected.literalPrompts, []);
      assert.deepStrictEqual(rejected.customMessages, []);
    }).pipe(Effect.provide(platformLayer)),
  );
});
