import type * as Effect from "effect/Effect";
import type { ConfigError } from "./errors.ts";

export type InstructionsScope =
  | { readonly kind: "global" }
  | {
      readonly kind: "discord";
      readonly botId: string | null;
      readonly channelId: string;
    };

export type InstructionsReader = (scope: InstructionsScope) => Effect.Effect<string, ConfigError>;
