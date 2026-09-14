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
    name: "switch",
    description: "Choose the model for this chat",
    options: [
      {
        name: "model",
        description: "Model to use in this chat",
        type: ApplicationCommandOptionTypes.String,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "btw",
    description: "Ask a side question without changing this chat's conversation",
    options: [
      {
        name: "question",
        description: "Question about the current conversation",
        type: ApplicationCommandOptionTypes.String,
        required: true,
      },
    ],
  },
  {
    name: "abort",
    description: "Stop this chat's current run",
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
  readonly focused?: boolean;
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

export type BtwCommand =
  | { readonly kind: "btw"; readonly question: string }
  | { readonly kind: "malformedBtw" };

export type SwitchCommand =
  | { readonly kind: "switch"; readonly model: string }
  | { readonly kind: "malformedSwitch" };

export type Command =
  | BindCommand
  | ShakeCommand
  | BtwCommand
  | SwitchCommand
  | { readonly kind: "abort" }
  | { readonly kind: "context" }
  | { readonly kind: "close" };

export const parse = (
  name: string | undefined,
  options: ReadonlyArray<CommandOption> | undefined,
): Command | undefined => {
  switch (name) {
    case "bind":
      return parseBind(options);
    case "shake":
      return parseShake(options);
    case "btw":
      return parseBtw(options);
    case "switch":
      return parseSwitch(options);
    case "abort":
      return { kind: "abort" };
    case "context":
      return { kind: "context" };
    case "close":
      return { kind: "close" };
    default:
      return undefined;
  }
};

const parseBtw = (options: ReadonlyArray<CommandOption> | undefined): BtwCommand => {
  if (options?.length !== 1) return { kind: "malformedBtw" };
  const question = options[0];
  if (
    question?.name !== "question" ||
    question.type !== ApplicationCommandOptionTypes.String ||
    typeof question.value !== "string" ||
    question.options !== undefined ||
    question.value.trim().length === 0
  ) {
    return { kind: "malformedBtw" };
  }
  return { kind: "btw", question: question.value.trim() };
};

const modelOption = (options: ReadonlyArray<CommandOption> | undefined) => {
  if (options?.length !== 1) return undefined;
  const model = options[0];
  if (
    model?.name !== "model" ||
    model.type !== ApplicationCommandOptionTypes.String ||
    typeof model.value !== "string" ||
    model.options !== undefined
  ) {
    return undefined;
  }
  return { value: model.value, focused: model.focused };
};

export const parseModelQuery = (options: ReadonlyArray<CommandOption> | undefined) => {
  const model = modelOption(options);
  return model?.focused === true ? model.value : undefined;
};

const parseSwitch = (options: ReadonlyArray<CommandOption> | undefined): SwitchCommand => {
  const model = modelOption(options);
  if (
    model === undefined ||
    model.focused === true ||
    model.value.trim().length === 0 ||
    model.value.length > 100
  ) {
    return { kind: "malformedSwitch" };
  }
  return { kind: "switch", model: model.value };
};

const parseBind = (options: ReadonlyArray<CommandOption> | undefined): BindCommand => {
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

const parseShake = (options: ReadonlyArray<CommandOption> | undefined): ShakeCommand => {
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
