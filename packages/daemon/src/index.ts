import * as BranchNaming from "@pico/application/branch-naming";
import * as ApplicationLayer from "@pico/application/layer";
import * as SessionContext from "@pico/application/session-context";
import * as Config from "@pico/config/config";
import * as Instructions from "@pico/config/instructions";
import * as ConfigRoot from "@pico/config/root";
import type { PicoPaths, PicoRoot } from "@pico/contract/config";
import {
  AgentError,
  ApplicationError,
  ConfigError,
  GitError,
  LoggingError,
  PersistenceError,
} from "@pico/contract/errors";
import {
  ScheduleError,
  ScheduleHostError,
  SchedulePlatformService,
  type ScheduleRunHost,
  ScheduleRunHostFactory,
} from "@pico/contract/schedule";
import * as DiscordLayer from "@pico/discord/layer";
import * as EventRouterLayer from "@pico/event-router/layer";
import * as GitWorktree from "@pico/git/worktree";
import * as LoggingLayer from "@pico/logging/layer";
import * as AgentSessionStoreLayer from "@pico/omp/agent-session-store";
import * as AgentRuntimeLayer from "@pico/omp/layer";
import * as PersistenceLayer from "@pico/persistence/layer";
import * as ScheduleLayer from "@pico/schedule/layer";
import { AssetBuildError } from "@pico/web/assets";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Web from "./web.ts";

// Embedders acquire a daemon in their own scope and own any propagated failure.
export const open = Effect.fn("Daemon.open")(function* (root: PicoRoot) {
  const scope = yield* Scope.fork(yield* Effect.scope);
  return yield* Effect.gen(function* () {
    const paths = yield* ConfigRoot.open(root);
    const loggingContext = yield* Layer.build(LoggingLayer.layer(paths.logsDir));
    return yield* Effect.gen(function* () {
      const config = yield* Config.load(paths);
      return yield* openComponents(paths, config);
    }).pipe(Effect.provide(loggingContext));
  }).pipe(
    Scope.provide(scope),
    Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
  );
});

// The CLI receives the reported result only after resources and loggers have closed.
export const run = Effect.fn("Daemon.run")(
  function* <E, R>(root: PicoRoot, lifetime: Effect.Effect<void, E, R>) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const loggerScope = yield* Scope.make();
        const resourceScope = yield* Scope.make();
        let loggingContext = Context.empty();
        let phase: "startup" | "running" | "shutdown" = "startup";
        const bodyExit = yield* restore(
          Effect.gen(function* () {
            const paths = yield* ConfigRoot.open(root);
            loggingContext = yield* Layer.buildWithScope(
              LoggingLayer.layer(paths.logsDir),
              loggerScope,
            );
            yield* Effect.gen(function* () {
              yield* Effect.logInfo("pico.daemon.starting").pipe(
                Effect.annotateLogs({ phase: "startup" }),
              );
              const config = yield* Config.load(paths);
              yield* openComponents(paths, config);
              phase = "running";
              yield* lifetime;
              phase = "shutdown";
              yield* Effect.logInfo("pico.daemon.stopping").pipe(
                Effect.annotateLogs({ phase: "shutdown" }),
              );
            }).pipe(Effect.provide(loggingContext));
          }).pipe(Scope.provide(resourceScope)),
        ).pipe(Effect.exit);
        const resourceExit = yield* Scope.close(resourceScope, bodyExit).pipe(
          Effect.provide(loggingContext),
          Effect.exit,
        );
        const exit = Exit.asVoidAll([bodyExit, resourceExit]);

        yield* (
          Exit.isFailure(exit)
            ? reportFailure(exit.cause, phase)
            : Effect.logInfo("pico.daemon.stopped").pipe(
                Effect.annotateLogs({ phase: "shutdown", outcome: "success" }),
              )
        ).pipe(Effect.provide(loggingContext));

        const loggerExit = yield* Scope.close(loggerScope, exit).pipe(Effect.exit);
        if (Exit.isFailure(loggerExit)) {
          yield* reportFailure(loggerExit.cause, "logging-close");
        }
        return Exit.asVoidAll([exit, loggerExit]);
      }),
    );
  },
  Effect.annotateLogs({ component: "daemon", operation: "run" }),
);

const openComponents = Effect.fn("Daemon.openComponents")(function* (
  paths: PicoPaths,
  config: Config.PicoConfig,
) {
  const context = yield* Layer.build(daemonLayer(paths, config));
  const web = yield* Web.open(config.web.port).pipe(Effect.provide(context));
  yield* Effect.logInfo("pico.daemon.ready").pipe(
    Effect.annotateLogs({
      phase: "ready",
      discord: Option.isSome(config.discord) ? "enabled" : "disabled",
      rpc: "enabled",
      webUrl: web.webUrl,
    }),
  );
  return web;
});

const reportFailure = (cause: Cause.Cause<unknown>, phase: string) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
  const safeCause = Cause.fromReasons(
    cause.reasons.map((reason) => {
      if (reason._tag === "Interrupt") return reason;
      const error = reason._tag === "Fail" ? reason.error : reason.defect;
      if (
        error instanceof ConfigError ||
        error instanceof LoggingError ||
        error instanceof PersistenceError ||
        error instanceof GitError ||
        error instanceof AgentError ||
        error instanceof ApplicationError ||
        error instanceof ScheduleError ||
        error instanceof ScheduleHostError ||
        error instanceof AssetBuildError ||
        error instanceof DiscordLayer.DiscordError
      )
        return reason;
      const safeError = new Error(
        reason._tag === "Fail" ? "Daemon operation failed" : "Unexpected daemon defect",
      );
      return reason._tag === "Fail"
        ? Cause.makeFailReason(safeError)
        : Cause.makeDieReason(safeError);
    }),
  );
  return Effect.logError("pico.daemon.failed", safeCause).pipe(
    Effect.annotateLogs({ phase, outcome: "failure" }),
  );
};

const daemonLayer = (paths: PicoPaths, config: Config.PicoConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const gitWorktree = yield* GitWorktree.make(paths.worktreesDir);
      const scheduleHostReady = yield* Deferred.make<ScheduleRunHost>();
      const schedules = yield* ScheduleLayer.open(paths.schedulesDir, (input) =>
        Effect.gen(function* () {
          const ready = yield* Deferred.poll(scheduleHostReady);
          if (Option.isNone(ready)) {
            return yield* new ScheduleHostError({
              message: "Schedule destinations are not ready",
            });
          }
          return yield* (yield* ready.value).resolveTarget(input);
        }),
      );
      const instructions = yield* Instructions.make(paths.root);
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
      const branchNaming = BranchNaming.layer(gitWorktree).pipe(Layer.provide(persistence));
      const chatSessionContext = SessionContext.layer({
        instructions,
        discordBotId,
      }).pipe(Layer.provide(persistence));
      const application = ApplicationLayer.layer(gitWorktree).pipe(
        Layer.provide(AgentSessionStoreLayer.layer(paths.sessionsDir)),
        Layer.provideMerge(persistence),
      );
      const agentRuntime = AgentRuntimeLayer.layer({
        paths,
        schedules,
        browser: config.browser,
      }).pipe(Layer.provide(Layer.merge(chatSessionContext, branchNaming)));
      const core = Layer.merge(application, EventRouterLayer.layer).pipe(
        Layer.provide(agentRuntime),
      );
      const surfaces =
        discord === null
          ? core
          : DiscordLayer.layer(discord.config, {
              onAuthenticated: (id) => {
                Deferred.doneUnsafe(discord.authenticated, Effect.succeed(id));
              },
            }).pipe(Layer.provideMerge(core));
      const scheduler = Layer.effectDiscard(
        Effect.gen(function* () {
          const makeHost = yield* ScheduleRunHostFactory;
          const platform = yield* Effect.serviceOption(SchedulePlatformService);
          const host = makeHost(Option.getOrNull(platform));
          yield* Deferred.succeed(scheduleHostReady, host);
          yield* schedules.start(host);
        }),
      ).pipe(Layer.provide(surfaces));

      return Layer.merge(surfaces, scheduler);
    }),
  );
