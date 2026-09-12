import * as ApplicationLayer from "@pico/application/layer";
import * as SessionContext from "@pico/application/session-context";
import * as Config from "@pico/config/config";
import * as Identity from "@pico/config/identity";
import * as ConfigRoot from "@pico/config/root";
import type { PicoPaths, PicoRoot } from "@pico/contract/config";
import { AgentError } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import { ScheduleRunHostService } from "@pico/contract/schedule";
import * as DiscordLayer from "@pico/discord/layer";
import * as EventRouterLayer from "@pico/event-router/layer";
import * as GitWorktree from "@pico/git/worktree";
import * as LoggingLayer from "@pico/logging/layer";
import * as AgentSessionStoreLayer from "@pico/omp/agent-session-store";
import * as AgentRuntimeLayer from "@pico/omp/layer";
import * as PersistenceLayer from "@pico/persistence/layer";
import * as ScheduleLayer from "@pico/schedule/layer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const open = Effect.fn("Daemon.open")(function* (root: PicoRoot) {
  const paths = yield* ConfigRoot.open(root);
  const config = yield* Config.load(paths);
  const loggingContext = yield* Layer.build(LoggingLayer.layer(paths.logsDir));

  yield* Layer.build(daemonLayer(paths, config)).pipe(
    Effect.andThen(Effect.logInfo(`pico.daemon.ready root=${paths.root}`)),
    Effect.provide(loggingContext),
  );
});

const daemonLayer = (paths: PicoPaths, config: Config.PicoConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const gitWorktree = yield* GitWorktree.make(paths.worktreesDir);
      const schedules = yield* ScheduleLayer.open(paths.schedulesDir);
      const identity = yield* Identity.make(paths.root);
      const discord = Option.isSome(config.discord)
        ? { config: config.discord.value, authenticated: yield* Deferred.make<string>() }
        : null;
      const discordBotId =
        discord === null
          ? null
          : Effect.gen(function* () {
              const authenticated = yield* Deferred.poll(discord.authenticated);
              if (Option.isNone(authenticated)) {
                return yield* new AgentError({
                  message:
                    "Discord identity is not ready. The configured bot has not authenticated.",
                });
              }
              return yield* authenticated.value;
            });
      const persistence = PersistenceLayer.layer(paths.storeFile);
      const branchNaming = ApplicationLayer.branchNamingLayer(gitWorktree).pipe(
        Layer.provide(persistence),
      );
      const chatSessionContext = SessionContext.layer({
        identity,
        discordBotId,
      }).pipe(Layer.provide(persistence));
      const application = ApplicationLayer.layer(gitWorktree).pipe(
        Layer.provide(Layer.merge(persistence, AgentSessionStoreLayer.layer(paths.sessionsDir))),
      );
      const agentRuntime = AgentRuntimeLayer.layer(paths.sessionsDir, schedules).pipe(
        Layer.provide(Layer.merge(chatSessionContext, branchNaming)),
      );
      const core = Layer.merge(application, EventRouterLayer.layer).pipe(
        Layer.provide(agentRuntime),
      );
      const surfaces =
        discord === null
          ? core
          : DiscordLayer.layer(discord.config, (id) => {
              Deferred.doneUnsafe(discord.authenticated, Effect.succeed(id));
            }).pipe(Layer.provideMerge(core));
      const scheduler = Layer.effectDiscard(
        Effect.gen(function* () {
          const host = yield* ScheduleRunHostService;
          const router = yield* EventRouter;
          yield* schedules.start({
            ...host,
            deliver: (chatId, content) =>
              host.deliver(chatId, content).pipe(Effect.andThen(router.drain())),
            publish: (chatId, content) =>
              host.publish(chatId, content).pipe(Effect.andThen(router.drain())),
          });
        }),
      ).pipe(Layer.provide(surfaces));

      return Layer.merge(surfaces, scheduler);
    }),
  );
