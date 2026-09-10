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
      {
        name: "worktree",
        description: "Configure worktrees for new chats",
        type: ApplicationCommandOptionTypes.SubCommand,
        options: [
          {
            name: "repository",
            description: "Absolute Git repository path",
            type: ApplicationCommandOptionTypes.String,
            required: true,
          },
          {
            name: "branch",
            description: "Commit-ish starting ref",
            type: ApplicationCommandOptionTypes.String,
            required: true,
          },
          {
            name: "prefix",
            description: "Branch prefix for new chats",
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
    name: "close",
    description: "Close this chat and archive its thread",
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
  | { readonly kind: "bindDirect"; readonly cwd: string }
  | {
      readonly kind: "bindWorktree";
      readonly repository: string;
      readonly branch: string;
      readonly prefix: string;
    }
  | { readonly kind: "malformedBind" };

export type ShakeCommand =
  | {
      readonly kind: "shake";
      readonly mode: ShakeMode;
    }
  | { readonly kind: "malformedShake" };

export type Command =
  | BindCommand
  | ShakeCommand
  | { readonly kind: "context" }
  | { readonly kind: "close" };

export const parseBind = (options: ReadonlyArray<CommandOption> | undefined): BindCommand => {
  if (options?.length !== 1) return { kind: "malformedBind" };
  const subcommand = options[0];
  if (subcommand?.type !== ApplicationCommandOptionTypes.SubCommand) {
    return { kind: "malformedBind" };
  }

  if (subcommand.name === "set") {
    if (subcommand.options?.length !== 1) return { kind: "malformedBind" };
    const cwd = subcommand.options[0];
    if (
      cwd?.name !== "cwd" ||
      cwd.type !== ApplicationCommandOptionTypes.String ||
      typeof cwd.value !== "string" ||
      cwd.options !== undefined
    ) {
      return { kind: "malformedBind" };
    }
    return { kind: "bindDirect", cwd: cwd.value };
  }

  if (subcommand.name !== "worktree" || subcommand.options?.length !== 3) {
    return { kind: "malformedBind" };
  }
  const repository = subcommand.options.find(({ name }) => name === "repository");
  const branch = subcommand.options.find(({ name }) => name === "branch");
  const prefix = subcommand.options.find(({ name }) => name === "prefix");
  if (
    repository?.type !== ApplicationCommandOptionTypes.String ||
    typeof repository.value !== "string" ||
    repository.options !== undefined ||
    branch?.type !== ApplicationCommandOptionTypes.String ||
    typeof branch.value !== "string" ||
    branch.options !== undefined ||
    prefix?.type !== ApplicationCommandOptionTypes.String ||
    typeof prefix.value !== "string" ||
    prefix.options !== undefined
  ) {
    return { kind: "malformedBind" };
  }
  return {
    kind: "bindWorktree",
    repository: repository.value,
    branch: branch.value,
    prefix: prefix.value,
  };
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
