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
  it("registers and parses the nested bind set command", () => {
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
    ]);
    assert.deepStrictEqual(DiscordCommand.parse(validOptions), {
      kind: "bindSetCwd",
      cwd: "  /raw/path  ",
    });
  });

  it("rejects every malformed command shape", () => {
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
      assert.deepStrictEqual(DiscordCommand.parse(options), { kind: "malformed" });
    }
  });
});
