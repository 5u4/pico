import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { PicoRoot } from "@pico/contract/config";
import * as Daemon from "@pico/daemon";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";

const smoke = Effect.fn("Daemon.smoke")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-daemon-smoke-" });
  const canonicalRoot = yield* fileSystem.realPath(root);
  const lockFile = path.join(canonicalRoot, ".pico.lock");
  const storeFile = path.join(canonicalRoot, "store.db");
  const sessionsDir = path.join(canonicalRoot, "sessions");
  const logsDir = path.join(canonicalRoot, "logs");
  const schedulesDir = path.join(canonicalRoot, "schedules");

  const webUrl = yield* Effect.scoped(
    Effect.gen(function* () {
      const { webUrl } = yield* Daemon.open(PicoRoot.make(canonicalRoot));
      assert.match(webUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

      const document = yield* client.get(webUrl);
      assert.strictEqual(document.status, 200);
      assert.include(document.headers["content-type"], "text/html");
      assert.strictEqual(document.headers["cache-control"], "no-store");
      assert.strictEqual(document.headers["x-content-type-options"], "nosniff");
      assert.strictEqual(document.headers["x-frame-options"], "DENY");
      yield* document.text;

      const head = yield* client.head(`${webUrl}/__design`);
      assert.strictEqual(head.status, 200);
      assert.strictEqual(yield* head.text, "");
      const image = yield* client.get(`${webUrl}/interface-study.svg`);
      assert.strictEqual(image.status, 200);
      assert.include(image.headers["content-type"], "image/svg+xml");
      yield* image.text;

      for (const route of ["/package.json", "/src/main.tsx", "/.env", "/store.db", "/missing.js"]) {
        assert.strictEqual((yield* client.get(`${webUrl}${route}`)).status, 404);
      }
      const badHost = yield* client.get(webUrl, { headers: { host: "attacker.invalid" } });
      assert.strictEqual(badHost.status, 403);
      const badOrigin = yield* client.get(webUrl, {
        headers: { origin: "https://attacker.invalid" },
      });
      assert.strictEqual(badOrigin.status, 403);
      assert.strictEqual((yield* client.post(webUrl)).status, 405);
      assert.strictEqual((yield* client.get(`${webUrl}/rpc`)).status, 426);

      for (const expected of [lockFile, storeFile, sessionsDir, logsDir, schedulesDir]) {
        assert.isTrue(yield* fileSystem.exists(expected), `Missing ${expected}`);
      }
      for (const child of ["enabled", "disabled", "runs", ".staging"]) {
        assert.isTrue(
          yield* fileSystem.exists(path.join(schedulesDir, child)),
          `Missing schedule directory ${child}`,
        );
      }
      return webUrl;
    }),
  );

  assert.isFalse(yield* fileSystem.exists(lockFile), "Root lock remains after scope closure");
  assert.isTrue(
    Exit.isFailure(yield* client.get(webUrl).pipe(Effect.exit)),
    "Web listener remains after scope closure",
  );
});

describe("daemon library", () => {
  it.effect("serves local Web only while owning one root", () =>
    smoke().pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(BunServices.layer),
      Effect.scoped,
    ),
  );
});
