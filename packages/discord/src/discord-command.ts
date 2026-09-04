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
] satisfies Array<CreateApplicationCommand>;

export interface CommandOption {
  readonly name: string;
  readonly type: ApplicationCommandOptionTypes;
  readonly value?: string | number | boolean;
  readonly options?: ReadonlyArray<CommandOption>;
}

export type Command =
  | { readonly kind: "bindSetCwd"; readonly cwd: string }
  | { readonly kind: "malformed" };

export const parse = (options: ReadonlyArray<CommandOption> | undefined): Command => {
  if (options?.length !== 1) return { kind: "malformed" };
  const set = options[0];
  if (
    set?.name !== "set" ||
    set.type !== ApplicationCommandOptionTypes.SubCommand ||
    set.options?.length !== 1
  ) {
    return { kind: "malformed" };
  }

  const cwd = set.options[0];
  if (
    cwd?.name !== "cwd" ||
    cwd.type !== ApplicationCommandOptionTypes.String ||
    typeof cwd.value !== "string"
  ) {
    return { kind: "malformed" };
  }
  return { kind: "bindSetCwd", cwd: cwd.value };
};
