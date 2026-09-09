import type { ShakeMode } from "@pico/contract/agent-runtime";
import { ApplicationCommandOptionTypes, type CreateApplicationCommand } from "discordeno";

export const applicationCommands = [
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
] satisfies Array<CreateApplicationCommand>;

export interface CommandOption {
  readonly name: string;
  readonly type: ApplicationCommandOptionTypes;
  readonly value?: string | number | boolean;
  readonly options?: ReadonlyArray<CommandOption>;
}

export type BindCommand =
  | { readonly kind: "bindSetCwd"; readonly cwd: string }
  | { readonly kind: "malformedBind" };

export type ShakeCommand =
  | {
      readonly kind: "shake";
      readonly mode: ShakeMode;
    }
  | { readonly kind: "malformedShake" };

export type Command = BindCommand | ShakeCommand | { readonly kind: "context" };

export const parseBind = (options: ReadonlyArray<CommandOption> | undefined): BindCommand => {
  if (options?.length !== 1) return { kind: "malformedBind" };
  const set = options[0];
  if (
    set?.name !== "set" ||
    set.type !== ApplicationCommandOptionTypes.SubCommand ||
    set.options?.length !== 1
  ) {
    return { kind: "malformedBind" };
  }

  const cwd = set.options[0];
  if (
    cwd?.name !== "cwd" ||
    cwd.type !== ApplicationCommandOptionTypes.String ||
    typeof cwd.value !== "string"
  ) {
    return { kind: "malformedBind" };
  }
  return { kind: "bindSetCwd", cwd: cwd.value };
};

export const parseShake = (options: ReadonlyArray<CommandOption> | undefined): ShakeCommand => {
  if (options === undefined || options.length === 0) {
    return { kind: "shake", mode: "elide" };
  }
  if (options.length !== 1) return { kind: "malformedShake" };

  const mode = options[0];
  if (
    mode?.name !== "mode" ||
    mode.type !== ApplicationCommandOptionTypes.String ||
    mode.options !== undefined ||
    (mode.value !== "elide" && mode.value !== "images" && mode.value !== "thinking")
  ) {
    return { kind: "malformedShake" };
  }
  return { kind: "shake", mode: mode.value };
};
