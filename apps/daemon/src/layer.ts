import * as ApplicationLayer from "@pico/application/layer";
import type { PicoPaths } from "@pico/contract/config";
import * as EventRouterLayer from "@pico/event-router/layer";
import * as GitWorktree from "@pico/git/worktree";
import * as AgentSessionStoreLayer from "@pico/omp/agent-session-store";
import * as AgentRuntimeLayer from "@pico/omp/layer";
import * as PersistenceLayer from "@pico/persistence/layer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const layer = (paths: PicoPaths) =>
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
      const eventRouter = EventRouterLayer.layer.pipe(Layer.provide(agentRuntime));

      return Layer.merge(application, eventRouter);
    }),
  );
