import { writeSync } from "node:fs";
import { postmortem } from "@oh-my-pi/pi-utils";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";

type ShutdownSignal = "SIGINT" | "SIGTERM";
type ShutdownState =
  | { readonly kind: "running" }
  | { readonly kind: "stopping" }
  | { readonly kind: "completed" };
type RunMain = <A, E>(effect: Effect.Effect<A, E>) => void;

const INTERRUPTED_EXIT_CODE = 130;
const exitProcess = (code: number): never => {
  const current = typeof process.reallyExit === "function" ? process.reallyExit : process.exit;
  const native: unknown = Reflect.get(current, postmortem.NATIVE_PROCESS_EXIT);
  if (typeof native === "function") {
    native.call(process, code);
  } else {
    current.call(process, code);
  }
  throw new Error("Process exit returned");
};

const makeRuntime = () => {
  const shutdown = Promise.withResolvers<void>();
  let state: ShutdownState = { kind: "running" };

  const report = (message: string): void => {
    try {
      writeSync(process.stderr.fd, message);
    } catch {}
  };

  const cleanup = (): void => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };

  const forceExit = (message: string): void => {
    report(message);
    state = { kind: "completed" };
    cleanup();
    exitProcess(INTERRUPTED_EXIT_CODE);
  };

  const onSignal = (signal: ShutdownSignal): void => {
    switch (state.kind) {
      case "running": {
        state = { kind: "stopping" };
        report(`pico: stopping on ${signal}; send SIGINT or SIGTERM again to force exit\n`);
        shutdown.resolve();
        return;
      }
      case "stopping":
        forceExit(`pico: received ${signal} while stopping; forcing exit\n`);
        return;
      case "completed":
        return;
    }
  };

  function onSigint(): void {
    onSignal("SIGINT");
  }

  function onSigterm(): void {
    onSignal("SIGTERM");
  }

  const runMain: RunMain = (effect) => {
    const completed = Promise.withResolvers<void>();
    const cancelPostmortem = postmortem.register("pico-daemon", () => completed.promise, {
      exitOnly: true,
    });
    const runEffect = Runtime.makeRunMain(({ fiber, teardown }) => {
      fiber.addObserver((exit) => {
        const previous = state;
        completed.resolve();
        cancelPostmortem();

        if (previous.kind === "stopping") {
          teardown(exit, () => undefined);
          return;
        }

        state = { kind: "completed" };
        cleanup();
        teardown(exit, (code) => {
          if (code !== 0) exitProcess(code);
        });
      });
    });
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    try {
      runEffect(effect);
    } catch (error) {
      state = { kind: "completed" };
      completed.resolve();
      cancelPostmortem();
      cleanup();
      throw error;
    }
  };

  return {
    awaitShutdown: Effect.promise(() => shutdown.promise),
    runMain,
  };
};

const runtime = makeRuntime();

export const awaitShutdown = runtime.awaitShutdown;
export const runMain = runtime.runMain;
