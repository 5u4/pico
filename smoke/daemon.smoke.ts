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
      assert.strictEqual(document.headers["referrer-policy"], "no-referrer");
      assert.include(document.headers["content-security-policy"], "frame-ancestors 'none'");
      const html = yield* document.text;
      const scriptPath = html.match(/src="([^"]+\.js)"/)?.[1];
      const stylePath = html.match(/href="([^"]+\.css)"/)?.[1];
      if (scriptPath === undefined || stylePath === undefined) {
        return yield* Effect.die(new Error("Web document is missing compiled JavaScript or CSS"));
      }
      for (const { path, contentType } of [
        { path: scriptPath, contentType: "javascript" },
        { path: stylePath, contentType: "text/css" },
      ]) {
        const asset = yield* client.get(new URL(path, webUrl).href);
        assert.strictEqual(asset.status, 200);
        assert.include(asset.headers["content-type"], contentType);
        yield* asset.text;
        const head = yield* client.head(new URL(path, webUrl).href);
        assert.strictEqual(head.status, 200);
        assert.include(head.headers["content-type"], contentType);
        assert.strictEqual(yield* head.text, "");
        const wrongMethod = yield* client.post(new URL(path, webUrl).href);
        assert.strictEqual(wrongMethod.status, 405);
        assert.strictEqual(wrongMethod.headers.allow, "GET, HEAD");
      }

      const workspacePath = "/workspaces/00000000-0000-7000-8000-000000000001";
      const chatPath = `${workspacePath}/chats/00000000-0000-7000-8000-000000000002`;
      for (const route of [
        "/",
        "/workspaces/new",
        workspacePath,
        chatPath,
        `${workspacePath}/settings`,
        "/workspaces/not-a-uuid",
        `${workspacePath}/chats/not-a-uuid`,
        "/workspaces/not-a-uuid/settings",
        `${chatPath}?view=conversation`,
      ]) {
        const url = `${webUrl}${route}`;
        const page = yield* client.get(url);
        assert.strictEqual(page.status, 200, route);
        assert.strictEqual(yield* page.text, html, route);
        const head = yield* client.head(url);
        assert.strictEqual(head.status, 200, route);
        assert.strictEqual(yield* head.text, "", route);
        for (const name of [
          "content-type",
          "cache-control",
          "x-content-type-options",
          "x-frame-options",
          "referrer-policy",
          "content-security-policy",
        ]) {
          assert.strictEqual(page.headers[name], document.headers[name], `${route} GET ${name}`);
          assert.strictEqual(head.headers[name], document.headers[name], `${route} HEAD ${name}`);
        }
        const wrongMethod = yield* client.post(url);
        assert.strictEqual(wrongMethod.status, 405, route);
        assert.strictEqual(wrongMethod.headers.allow, "GET, HEAD", route);
        const badHost = yield* client.get(url, { headers: { host: "attacker.invalid" } });
        assert.strictEqual(badHost.status, 403, route);
        const badOrigin = yield* client.get(url, {
          headers: { origin: "https://attacker.invalid" },
        });
        assert.strictEqual(badOrigin.status, 403, route);
      }

      for (const route of [
        "/__design",
        "/interface-study.svg",
        "/package.json",
        "/src/main.tsx",
        "/.env",
        "/store.db",
        "/missing.js",
        "/assets/missing.js",
        "/rpc/missing",
        "/workspaces",
        "/workspaces/missing.js",
        "/workspaces/missing%2Ejs",
        `${workspacePath}/chats`,
        `${workspacePath}/chats/missing.js`,
        `${workspacePath}/settings/missing.js`,
        `${chatPath}/unknown`,
      ]) {
        const url = `${webUrl}${route}`;
        assert.strictEqual((yield* client.get(url)).status, 404, route);
        assert.strictEqual((yield* client.head(url)).status, 404, route);
        assert.strictEqual((yield* client.post(url)).status, 404, route);
      }
      const rpc = yield* client.get(`${webUrl}/rpc`);
      assert.strictEqual(rpc.status, 426);
      assert.strictEqual(rpc.headers.upgrade, "websocket");
      assert.strictEqual((yield* client.head(`${webUrl}/rpc`)).status, 405);
      const rpcPost = yield* client.post(`${webUrl}/rpc`);
      assert.strictEqual(rpcPost.status, 405);
      assert.strictEqual(rpcPost.headers.allow, "GET");
      assert.strictEqual(
        (yield* client.get(`${webUrl}/rpc`, { headers: { host: "attacker.invalid" } })).status,
        403,
      );
      assert.strictEqual(
        (yield* client.get(`${webUrl}/rpc`, { headers: { origin: "https://attacker.invalid" } }))
          .status,
        403,
      );

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
