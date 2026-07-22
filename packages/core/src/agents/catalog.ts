import type { Model } from "@oh-my-pi/pi-catalog";
import { ModelRegistry, type Settings } from "@oh-my-pi/pi-coding-agent";
import {
  pickDefaultAvailableModel,
  resolveRoleSelection,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Effect } from "effect";
import { Auth } from "./auth.ts";
import { ModelUnavailable } from "./errors.ts";

export class Catalog extends Effect.Service<Catalog>()("pico/Catalog", {
  dependencies: [Auth.Default],
  effect: Effect.gen(function* () {
    const auth = yield* Auth;
    const registry = new ModelRegistry(auth.storage);
    yield* Effect.tryPromise({
      try: () => registry.refresh("online-if-uncached"),
      catch: (cause) => new ModelUnavailable({ detail: String(cause) }),
    });

    const resolveDefaultModel = (
      settings: Settings,
    ): Effect.Effect<Model, ModelUnavailable> =>
      Effect.gen(function* () {
        const available = registry.getAvailable();
        const model =
          resolveRoleSelection(["default"], settings, available)?.model ??
          pickDefaultAvailableModel(available);
        if (!model) {
          return yield* new ModelUnavailable({
            detail: "no available model resolved from registry",
          });
        }
        return model;
      });

    return { registry, resolveDefaultModel };
  }),
}) {}
