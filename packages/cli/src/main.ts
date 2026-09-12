#!/usr/bin/env bun
import * as BunServices from "@effect/platform-bun/BunServices";
import { PicoRoot } from "@pico/contract/config";
import * as Daemon from "@pico/daemon";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Argument from "effect/unstable/cli/Argument";
import * as CliError from "effect/unstable/cli/CliError";
import * as Command from "effect/unstable/cli/Command";
import { awaitShutdown, runMain } from "./runtime.ts";

const version = "0.0.0";

const parseRoot = Effect.fn("Cli.parseRoot")(function* (root: Option.Option<string>) {
  const path = yield* Path.Path;

  if (Option.isSome(root)) {
    if (!path.isAbsolute(root.value)) {
      return yield* new CliError.InvalidValue({
        option: "root",
        value: root.value,
        expected: "an absolute path",
        kind: "argument",
      });
    }
    return PicoRoot.make(path.normalize(root.value));
  }

  const home = Bun.env.HOME;
  if (home === undefined || !path.isAbsolute(home)) {
    return yield* new CliError.UserError({
      cause: new Error("HOME must be an absolute path"),
      userMessage: "HOME must be an absolute path",
    });
  }
  return PicoRoot.make(path.normalize(path.join(home, ".pico")));
});

const root = Argument.string("root").pipe(
  Argument.withDescription("Absolute pico root. Defaults to $HOME/.pico"),
  Argument.optional,
  Argument.mapEffect(parseRoot),
);

const start = Command.make("start", { root }).pipe(
  Command.withHandler(({ root }) =>
    Effect.scoped(Daemon.open(root).pipe(Effect.andThen(awaitShutdown))),
  ),
  Command.withDescription("Start the daemon in the foreground"),
);

const pico = Command.make("pico").pipe(
  Command.withDescription("Run pico"),
  Command.withSubcommands([start]),
);

const main = Command.run(pico, { version }).pipe(Effect.provide(BunServices.layer));

runMain(main);
