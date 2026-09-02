import * as ApplicationLayer from "@pico/application/layer";
import * as Config from "@pico/config/config";
import * as ConfigRoot from "@pico/config/root";
import type { PicoPaths, PicoRoot } from "@pico/contract/config";
import * as DiscordLayer from "@pico/discord/layer";
import * as EventRouterLayer from "@pico/event-router/layer";
import * as GitWorktree from "@pico/git/worktree";
import * as LoggingLayer from "@pico/logging/layer";
import * as AgentSessionStoreLayer from "@pico/omp/agent-session-store";
import * as AgentRuntimeLayer from "@pico/omp/layer";
import * as PersistenceLayer from "@pico/persistence/layer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const open = Effect.fn("Daemon.open")(function* (root: PicoRoot) {
  const paths = yield* ConfigRoot.open(root);
  const config = yield* Config.load(paths);

  yield* Layer.build(
    daemonLayer(paths, config).pipe(
      Layer.tap(() => Effect.logInfo(`pico.daemon.ready root=${paths.root}`)),
      Layer.provide(LoggingLayer.layer(paths.logsDir)),
    ),
  );
});

const daemonLayer = (paths: PicoPaths, config: Config.PicoConfig) =>
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
        onSome: (discord) => DiscordLayer.layer(discord).pipe(Layer.provideMerge(core)),
      });
    }),
  );
