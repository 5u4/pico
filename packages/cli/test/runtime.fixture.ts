import { writeSync } from "node:fs";
import { postmortem } from "@oh-my-pi/pi-utils";
import * as Effect from "effect/Effect";
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

runMain(effect);
if (mode === "immediate") {
  const listenersAfter = listenerCounts();
  const listenersClean =
    listenersAfter.sigint === listenersBefore.sigint &&
    listenersAfter.sigterm === listenersBefore.sigterm;
  const status = listenersClean ? "LISTENERS_CLEAN" : "LISTENER_LEAK";
  writeSync(process.stdout.fd, `${status}\n`);
}
