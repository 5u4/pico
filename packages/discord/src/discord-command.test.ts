import { assert, describe, it } from "@effect/vitest";
import { ApplicationCommandOptionTypes } from "discordeno";
import * as DiscordCommand from "./discord-command.ts";

const validOptions = [
  {
    name: "set",
    type: ApplicationCommandOptionTypes.SubCommand,
    options: [
      {
        name: "cwd",
        type: ApplicationCommandOptionTypes.String,
        value: "  /raw/path  ",
      },
    ],
  },
] as const;

const worktreeOptions = (options: ReadonlyArray<DiscordCommand.CommandOption>) => [
  {
    name: "worktree",
    type: ApplicationCommandOptionTypes.SubCommand,
    options,
  },
];

describe("Discord command", () => {
  it("distinguishes focused partial model queries from submitted selections", () => {
    const option = {
      name: "model",
      type: ApplicationCommandOptionTypes.String,
      value: "",
      focused: true,
    };
    assert.strictEqual(DiscordCommand.parseModelQuery([option]), "");
    assert.strictEqual(DiscordCommand.parseModelQuery([{ ...option, value: "cla" }]), "cla");
    assert.deepStrictEqual(
      DiscordCommand.parse("switch", [{ ...option, value: "provider/model" }]),
      {
        kind: "malformedSwitch",
      },
    );
    assert.deepStrictEqual(
      DiscordCommand.parse("switch", [{ ...option, focused: false, value: "provider/model" }]),
      { kind: "switch", model: "provider/model" },
    );
    for (const options of [
      undefined,
      [],
      [{ ...option, focused: false }],
      [{ ...option, name: "other" }],
      [{ ...option, type: ApplicationCommandOptionTypes.Integer }],
      [{ ...option, value: 12 }],
      [{ ...option, options: [] }],
      [option, option],
    ]) {
      assert.isUndefined(DiscordCommand.parseModelQuery(options));
    }
    for (const options of [
      undefined,
      [],
      [{ ...option, focused: false, value: "" }],
      [{ ...option, focused: false, value: " \n\t" }],
      [{ ...option, focused: false, value: "x".repeat(101) }],
      [{ ...option, focused: false, value: true }],
      [option, option],
    ]) {
      assert.deepStrictEqual(DiscordCommand.parse("switch", options), { kind: "malformedSwitch" });
    }
  });

  it("decodes commands without options and ignores unknown names", () => {
    for (const kind of ["abort", "close", "context"] as const) {
      assert.deepStrictEqual(DiscordCommand.parse(kind, undefined), { kind });
      assert.deepStrictEqual(DiscordCommand.parse(kind, []), { kind });
    }
    assert.isUndefined(DiscordCommand.parse(undefined, validOptions));
    assert.isUndefined(DiscordCommand.parse("unknown", validOptions));
  });

  it("accepts one text question and rejects empty or malformed side questions", () => {
    const question = {
      name: "question",
      type: ApplicationCommandOptionTypes.String,
      value: "  What is running?\n ",
    };
    assert.deepStrictEqual(DiscordCommand.parse("btw", [question]), {
      kind: "btw",
      question: "What is running?",
    });
    for (const options of [
      undefined,
      [],
      [{ ...question, value: " \n\t" }],
      [{ ...question, value: 42 }],
      [{ ...question, name: "other" }],
      [{ ...question, type: ApplicationCommandOptionTypes.Integer }],
      [{ ...question, options: [] }],
      [question, question],
    ]) {
      assert.deepStrictEqual(DiscordCommand.parse("btw", options), { kind: "malformedBtw" });
    }
  });

  it("parses bind without rewriting cwd", () => {
    assert.deepStrictEqual(DiscordCommand.parse("bind", validOptions), {
      kind: "bindDirect",
      cwd: "  /raw/path  ",
    });
  });

  it("parses worktree options independently of their order", () => {
    const repository = {
      name: "repository",
      type: ApplicationCommandOptionTypes.String,
      value: "/repo",
    } as const;
    const branch = {
      name: "branch",
      type: ApplicationCommandOptionTypes.String,
      value: "main",
    } as const;
    const prefix = {
      name: "prefix",
      type: ApplicationCommandOptionTypes.String,
      value: "chat/",
    } as const;
    for (const options of [
      [repository, branch, prefix],
      [prefix, repository, branch],
      [branch, prefix, repository],
    ]) {
      assert.deepStrictEqual(DiscordCommand.parse("bind", worktreeOptions(options)), {
        kind: "bindWorktree",
        repository: "/repo",
        branch: "main",
        prefix: "chat/",
      });
    }
  });

  it("rejects every malformed bind shape", () => {
    for (const options of [
      undefined,
      [],
      [{ ...validOptions[0], name: "other" }],
      [{ ...validOptions[0], type: ApplicationCommandOptionTypes.SubCommandGroup }],
      [{ ...validOptions[0], options: [] }],
      [
        {
          ...validOptions[0],
          options: [{ ...validOptions[0].options[0], name: "other" }],
        },
      ],
      [
        {
          ...validOptions[0],
          options: [
            {
              ...validOptions[0].options[0],
              type: ApplicationCommandOptionTypes.Integer,
            },
          ],
        },
      ],
      [
        {
          ...validOptions[0],
          options: [{ ...validOptions[0].options[0], value: 42 }],
        },
      ],
    ]) {
      assert.deepStrictEqual(DiscordCommand.parse("bind", options), { kind: "malformedBind" });
    }

    for (const options of [
      worktreeOptions([]),
      worktreeOptions([
        { name: "repository", type: ApplicationCommandOptionTypes.String, value: "/repo" },
        { name: "branch", type: ApplicationCommandOptionTypes.String, value: "main" },
      ]),
      worktreeOptions([
        { name: "repository", type: ApplicationCommandOptionTypes.String, value: "/repo" },
        { name: "branch", type: ApplicationCommandOptionTypes.String, value: "main" },
        { name: "branch", type: ApplicationCommandOptionTypes.String, value: "other" },
      ]),
      worktreeOptions([
        { name: "repository", type: ApplicationCommandOptionTypes.String, value: "/repo" },
        { name: "branch", type: ApplicationCommandOptionTypes.String, value: "main" },
        { name: "other", type: ApplicationCommandOptionTypes.String, value: "chat/" },
      ]),
      worktreeOptions([
        { name: "repository", type: ApplicationCommandOptionTypes.String, value: "/repo" },
        { name: "branch", type: ApplicationCommandOptionTypes.String, value: "main" },
        { name: "prefix", type: ApplicationCommandOptionTypes.Integer, value: "chat/" },
      ]),
    ]) {
      assert.deepStrictEqual(DiscordCommand.parse("bind", options), { kind: "malformedBind" });
    }
  });

  it("defaults shake to elide and constructs every selected mode", () => {
    assert.deepStrictEqual(DiscordCommand.parse("shake", undefined), {
      kind: "shake",
      mode: "elide",
    });
    assert.deepStrictEqual(DiscordCommand.parse("shake", []), { kind: "shake", mode: "elide" });
    for (const mode of ["elide", "images", "thinking"] as const) {
      assert.deepStrictEqual(
        DiscordCommand.parse("shake", [
          { name: "mode", type: ApplicationCommandOptionTypes.String, value: mode },
        ]),
        { kind: "shake", mode },
      );
    }
  });

  it("keeps malformed shake distinct from malformed bind", () => {
    for (const options of [
      [{ name: "other", type: ApplicationCommandOptionTypes.String, value: "elide" }],
      [
        {
          name: "mode",
          type: ApplicationCommandOptionTypes.String,
          value: "elide",
          options: [],
        },
      ],
      [{ name: "mode", type: ApplicationCommandOptionTypes.Integer, value: "elide" }],
      [{ name: "mode", type: ApplicationCommandOptionTypes.String, value: "other" }],
      [
        { name: "mode", type: ApplicationCommandOptionTypes.String, value: "elide" },
        { name: "mode", type: ApplicationCommandOptionTypes.String, value: "images" },
      ],
    ]) {
      assert.deepStrictEqual(DiscordCommand.parse("shake", options), { kind: "malformedShake" });
    }
  });
});
