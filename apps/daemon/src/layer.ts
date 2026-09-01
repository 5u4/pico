import * as ApplicationLayer from "@pico/application/layer";
import type { PicoConfig } from "@pico/config/config";
import type { PicoPaths } from "@pico/contract/config";
import * as DiscordLayer from "@pico/discord/layer";
import * as EventRouterLayer from "@pico/event-router/layer";
import * as GitWorktree from "@pico/git/worktree";
import * as AgentSessionStoreLayer from "@pico/omp/agent-session-store";
import * as AgentRuntimeLayer from "@pico/omp/layer";
import * as PersistenceLayer from "@pico/persistence/layer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const layer = (paths: PicoPaths, config: PicoConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const createWorktree = yield* GitWorktree.make(paths.worktreesDir);
      const persistence = PersistenceLayer.layer(paths.storeFile);
      const application = ApplicationLayer.layer(createWorktree).pipe(
        Layer.provide(Layer.merge(persistence, AgentSessionStoreLayer.layer(paths.sessionsDir))),
      );
      const agentRuntime = AgentRuntimeLayer.layer(paths.sessionsDir).pipe(
        Layer.provide(persistence),
      );
      const core = Layer.merge(application, EventRouterLayer.layer).pipe(
        Layer.provide(agentRuntime),
      );

      return Option.match(config.discord, {
        onNone: () => core,
        onSome: (config) => DiscordLayer.layer(config).pipe(Layer.provideMerge(core)),
      });
    }),
  );
