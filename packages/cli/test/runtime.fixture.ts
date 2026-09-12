import { writeSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { postmortem } from "@oh-my-pi/pi-utils";
import { PicoRoot } from "@pico/contract/config";
import { ConfigError } from "@pico/contract/errors";
import * as Daemon from "@pico/daemon";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Runtime from "effect/Runtime";
import { awaitShutdown, runMain } from "../src/runtime.ts";

const mode = process.argv[2];

const write = (fd: number, message: string) =>
  Effect.sync(() => {
    writeSync(fd, `${message}\n`);
  });

const writeStdout = (message: string) => write(process.stdout.fd, message);
const writeStderr = (message: string) => write(process.stderr.fd, message);

const scoped = (release: Effect.Effect<unknown, never>) =>
  Effect.acquireRelease(writeStdout("READY"), () => release).pipe(
    Effect.andThen(awaitShutdown),
    Effect.scoped,
  );

const listenerCounts = () => ({
  sigint: process.listenerCount("SIGINT"),
  sigterm: process.listenerCount("SIGTERM"),
});
const listenersBefore = listenerCounts();

const effect = (() => {
  switch (mode) {
    case "daemon-external-interruption":
      return Effect.gen(function* () {
        const root = process.argv[3];
        if (root === undefined) return yield* Effect.die("Missing fixture root");
        const started = yield* Deferred.make<void>();
        const daemon = yield* Daemon.run(
          PicoRoot.make(root),
          Effect.addFinalizer(() =>
            Effect.die(new ConfigError({ message: "Fixture cleanup failed" })),
          ).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(daemon);
        return yield* yield* Fiber.await(daemon);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
    case "daemon-finalizer-failure":
    case "daemon-mixed-interruption":
    case "daemon-root-release-failure":
    case "daemon-startup-interruption":
      return Effect.gen(function* () {
        const root = process.argv[3];
        if (root === undefined) return yield* Effect.die("Missing fixture root");
        const fileSystem = yield* FileSystem.FileSystem;
        const lifetime =
          mode === "daemon-root-release-failure" || mode === "daemon-startup-interruption"
            ? Effect.void
            : Effect.addFinalizer(() =>
                Effect.die(new ConfigError({ message: "Fixture cleanup failed" })),
              ).pipe(
                Effect.andThen(
                  mode === "daemon-mixed-interruption" ? Effect.interrupt : Effect.void,
                ),
              );
        const exit = yield* Daemon.run(PicoRoot.make(root), lifetime).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: (path) =>
              mode === "daemon-startup-interruption" && path.endsWith("/config.toml")
                ? Effect.interrupt
                : fileSystem.exists(path),
            remove: (path, options) =>
              mode === "daemon-root-release-failure" && path.endsWith("/.pico.lock")
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "remove",
                      description: "private-filesystem-detail",
                    }),
                  )
                : fileSystem.remove(path, options),
          }),
        );
        return yield* exit;
      }).pipe(Effect.provide(BunServices.layer));
    case "reusable-failure":
      return Effect.gen(function* () {
        const root = process.argv[3];
        if (root === undefined) return yield* Effect.die("Missing fixture root");
        yield* Daemon.open(PicoRoot.make(root));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
    case "immediate":
      return Effect.void;
    case "startup-signal":
      return Effect.acquireRelease(
        Effect.sync(() => process.emit("SIGINT")),
        () => writeStderr("FINALIZER_COMPLETED"),
      ).pipe(Effect.andThen(awaitShutdown), Effect.scoped);
    case "graceful":
      return scoped(writeStderr("FINALIZER_COMPLETED"));
    case "guarded-hanging":
      return scoped(writeStderr("FINALIZER_STARTED").pipe(Effect.andThen(Effect.never)));
    case "completing":
      return scoped(
        writeStderr("FINALIZER_STARTED").pipe(
          Effect.andThen(Effect.sleep("25 millis")),
          Effect.andThen(writeStderr("FINALIZER_COMPLETED")),
        ),
      );
    case "failure": {
      const error = new Error("fixture failure");
      Object.defineProperty(error, Runtime.errorExitCode, { value: 23 });
      return Effect.fail(error);
    }
    default:
      throw new Error(`Unknown fixture mode: ${mode}`);
  }
})();
if (mode === "guarded-hanging") {
  const nativeExit = typeof process.reallyExit === "function" ? process.reallyExit : process.exit;
  const guardedExit: typeof process.exit = () => {
    throw new Error("Guarded process exit was called");
  };
  Reflect.set(guardedExit, postmortem.NATIVE_PROCESS_EXIT, nativeExit);
  Reflect.set(process, "exit", guardedExit);
  Reflect.set(process, "reallyExit", guardedExit);
}

runMain(effect, { disableErrorReporting: mode?.startsWith("daemon-") === true });
if (mode === "immediate") {
  const listenersAfter = listenerCounts();
  const listenersClean =
    listenersAfter.sigint === listenersBefore.sigint &&
    listenersAfter.sigterm === listenersBefore.sigterm;
  const status = listenersClean ? "LISTENERS_CLEAN" : "LISTENER_LEAK";
  writeSync(process.stdout.fd, `${status}\n`);
}
