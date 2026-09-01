import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Config from "@pico/config/config";
import * as ConfigRoot from "@pico/config/root";
import { PicoRoot } from "@pico/contract/config";
import * as LoggingLayer from "@pico/logging/layer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { layer } from "./layer.ts";

const selectRoot = Effect.fn("Daemon.selectRoot")(function* () {
  const path = yield* Path.Path;
  const args = Bun.argv.slice(2);

  if (args.length > 1) {
    return yield* Effect.fail(new Error("Expected at most one absolute pico root"));
  }

  const supplied = args[0];
  if (supplied !== undefined) {
    if (!path.isAbsolute(supplied)) {
      return yield* Effect.fail(new Error("Pico root must be absolute"));
    }
    return PicoRoot.make(path.normalize(supplied));
  }

  const home = Bun.env.HOME;
  if (home === undefined || !path.isAbsolute(home)) {
    return yield* Effect.fail(new Error("HOME must be an absolute path"));
  }
  return PicoRoot.make(path.normalize(path.join(home, ".pico")));
});

const main = Effect.gen(function* () {
  const root = yield* selectRoot();
  const daemon = Layer.unwrap(
    ConfigRoot.open(root).pipe(
      Effect.flatMap((paths) =>
        Config.load(paths).pipe(
          Effect.map((config) =>
            layer(paths, config).pipe(
              Layer.tap(() => Effect.logInfo(`pico.daemon.ready root=${paths.root}`)),
              Layer.provide(LoggingLayer.layer(paths.logsDir)),
            ),
          ),
        ),
      ),
    ),
  );
  yield* Layer.launch(daemon);
}).pipe(Effect.provide(BunServices.layer));

BunRuntime.runMain(main);
