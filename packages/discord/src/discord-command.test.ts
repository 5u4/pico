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

describe("Discord command", () => {
  it("registers bind, shake, and context commands exactly", () => {
    assert.deepStrictEqual(DiscordCommand.applicationCommands, [
      {
        name: "bind",
        description: "Bind a channel workspace",
        options: [
          {
            name: "set",
            description: "Set workspace configuration",
            type: ApplicationCommandOptionTypes.SubCommand,
            options: [
              {
                name: "cwd",
                description: "Absolute working directory path",
                type: ApplicationCommandOptionTypes.String,
                required: true,
              },
            ],
          },
        ],
      },
      {
        name: "shake",
        description: "Drop heavy content from this chat's context",
        options: [
          {
            name: "mode",
            description: "What to remove. Defaults to elide",
            type: ApplicationCommandOptionTypes.String,
            choices: [
              { name: "Tool results and large blocks", value: "elide" },
              { name: "Images", value: "images" },
              { name: "Thinking", value: "thinking" },
            ],
          },
        ],
      },
      {
        name: "context",
        description: "Show this chat's context usage",
      },
    ]);
  });

  it("parses bind without rewriting cwd", () => {
    assert.deepStrictEqual(DiscordCommand.parseBind(validOptions), {
      kind: "bindSetCwd",
      cwd: "  /raw/path  ",
    });
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
      assert.deepStrictEqual(DiscordCommand.parseBind(options), { kind: "malformedBind" });
    }
  });

  it("defaults shake to elide and constructs every selected mode", () => {
    assert.deepStrictEqual(DiscordCommand.parseShake(undefined), { kind: "shake", mode: "elide" });
    assert.deepStrictEqual(DiscordCommand.parseShake([]), { kind: "shake", mode: "elide" });
    for (const mode of ["elide", "images", "thinking"] as const) {
      assert.deepStrictEqual(
        DiscordCommand.parseShake([
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
      assert.deepStrictEqual(DiscordCommand.parseShake(options), { kind: "malformedShake" });
    }
  });
});
