import type { ModelInfo, ModelRef } from "@pico/contract/agent-runtime";
import type { InteractionCallbackData } from "discordeno";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";

const encoder = new TextEncoder();

export const label = (model: ModelInfo) => {
  const text = `${model.provider}/${model.id} · ${model.name}`.replace(/\s+/g, " ");
  let end = 0;
  for (const character of text) {
    if (end + character.length > 100) break;
    end += character.length;
  }
  return text.slice(0, end);
};

export const choices = Effect.fn("DiscordModel.choices")(function* (
  crypto: Crypto.Crypto,
  models: readonly ModelInfo[],
  query: string,
) {
  const search = query.trim().toLowerCase();
  const result: NonNullable<InteractionCallbackData["choices"]> = [];
  for (const model of models) {
    if (
      search.length > 0 &&
      !`${model.provider}/${model.id}`.toLowerCase().includes(search) &&
      !model.name.toLowerCase().includes(search)
    ) {
      continue;
    }
    result.push({ name: label(model), value: yield* value(crypto, model) });
    if (result.length === 25) break;
  }
  return result;
});

export const resolve = Effect.fn("DiscordModel.resolve")(function* (
  crypto: Crypto.Crypto,
  models: readonly ModelInfo[],
  selection: string,
) {
  let selected: ModelInfo | undefined;
  for (const model of models) {
    if ((yield* value(crypto, model)) !== selection) continue;
    if (selected !== undefined) return undefined;
    selected = model;
  }
  return selected;
});

const value = Effect.fn("DiscordModel.value")(function* (crypto: Crypto.Crypto, model: ModelRef) {
  const identity = `${model.provider}/${model.id}`;
  if (identity.length <= 100) return identity;
  const digest = yield* crypto.digest(
    "SHA-256",
    encoder.encode(JSON.stringify([model.provider, model.id])),
  );
  return `sha256:${Encoding.encodeHex(digest)}`;
});
