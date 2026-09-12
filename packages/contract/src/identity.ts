import type * as Effect from "effect/Effect";
import type { ConfigError } from "./errors.ts";

export type IdentityScope =
  | { readonly kind: "global" }
  | {
      readonly kind: "discord";
      readonly botId: string | null;
      readonly channelId: string;
    };

export type IdentityReader = (scope: IdentityScope) => Effect.Effect<string, ConfigError>;
