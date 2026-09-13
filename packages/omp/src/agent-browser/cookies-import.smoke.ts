import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { it } from "@effect/vitest";
import { ChatId } from "@pico/contract/chat-model";
import * as Schema from "effect/Schema";
import { BrowserUnavailable, browserKey, prepareBrowserHome, sendBrowserCommand } from "./cli.ts";
import { type AgentBrowserOwner, makeAgentBrowserManager } from "./manager.ts";

const Result = Schema.Struct({ result: Schema.String });
const CookieState = Schema.Struct({
  auth: Schema.Boolean,
  host: Schema.Boolean,
  shared: Schema.Boolean,
  empty: Schema.Boolean,
  session: Schema.Boolean,
  expired: Schema.Boolean,
  existing: Schema.Boolean,
});
const SavedState = Schema.Struct({
  cookies: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.String,
      domain: Schema.String,
      path: Schema.String,
      httpOnly: Schema.Boolean,
      secure: Schema.Boolean,
      session: Schema.Boolean,
      expires: Schema.Number,
      sameSite: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
const safeError = (error: unknown, secrets: readonly string[], outcome?: RegExp) => {
  assert.ok(error instanceof Error);
  if (outcome) assert.match(error.message, outcome);
  for (const secret of secrets) assert.ok(!error.message.includes(secret));
  assert.equal(error.cause, undefined);
  return true;
};

it("rejects unapproved or invalid cookie files before creating owner or browser state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pico-cookie-consent-"));
  const root = join(directory, "pico");
  const file = join(directory, `secret-${crypto.randomUUID()}.json`);
  const cookie = {
    name: "private-name-sentinel",
    value: "private-value-sentinel",
    domain: "private-domain-sentinel.test",
  };
  const home = await prepareBrowserHome(root);
  const manager = await makeAgentBrowserManager({ root, idleTimeoutMs: 60_000 });
  const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000006");
  const owner = { chatId, instance: { kind: "main" } } as const;
  const session = browserKey(JSON.stringify([chatId, "main"]));
  const secrets = [file, basename(file), cookie.name, cookie.value, cookie.domain];
  const executeUnchecked = async (operation: unknown): Promise<unknown> =>
    Reflect.apply(manager.execute, manager, [owner, operation]);
  const noBrowserState = async () => {
    await assert.rejects(
      sendBrowserCommand(home, session, { action: "session_info" }),
      BrowserUnavailable,
    );
    assert.deepEqual(await readdir(join(home.directory, "owners")), []);
    assert.deepEqual(await readdir(home.stateDirectory), []);
    assert.deepEqual(await readdir(home.socketDirectory), []);
    assert.equal(await Bun.file(join(home.directory, "login-seed.json")).exists(), false);
  };
  try {
    await writeFile(file, JSON.stringify([cookie]));
    for (const userApproved of [undefined, false]) {
      await assert.rejects(
        executeUnchecked({ op: "import_cookies", path: file, userApproved }),
        (error) => safeError(error, secrets, /explicit user approval/),
      );
      await noBrowserState();
    }
    for (const path of [null, 42, basename(file)]) {
      await assert.rejects(
        executeUnchecked({ op: "import_cookies", path, userApproved: true }),
        (error) => safeError(error, secrets, /absolute file path/),
      );
      await noBrowserState();
    }
    await assert.rejects(
      manager.execute(owner, { op: "import_cookies", path: `${file}.missing`, userApproved: true }),
      (error) => safeError(error, secrets, /before submission/),
    );
    await noBrowserState();
    for (const input of [
      cookie.value,
      JSON.stringify([cookie, { ...cookie, httpOnly: "false" }]),
      JSON.stringify([cookie, { ...cookie, name: `__Http-${cookie.name}`, secure: true }]),
      JSON.stringify([cookie, { ...cookie, name: `__Host-Http-${cookie.name}`, secure: true }]),
      "[]",
    ]) {
      await writeFile(file, input);
      await assert.rejects(
        manager.execute(owner, { op: "import_cookies", path: file, userApproved: true }),
        (error) => safeError(error, secrets, /before submission/),
      );
      assert.equal(await readFile(file, "utf8"), input);
      await noBrowserState();
    }
    const header = `${cookie.name}=${cookie.value}`;
    await writeFile(file, header);
    for (const options of [
      { format: "header" },
      { format: "header", url: null },
      { format: "header", url: cookie.value },
      { format: "header", url: `ftp://${cookie.domain}` },
      { format: "header", url: `https://user:${cookie.value}@${cookie.domain}` },
      { format: "unknown" },
      { format: "json", url: `https://${cookie.domain}` },
    ]) {
      await assert.rejects(
        executeUnchecked({ op: "import_cookies", path: file, userApproved: true, ...options }),
        (error) => safeError(error, secrets, /before submission/),
      );
      assert.equal(await readFile(file, "utf8"), header);
      await noBrowserState();
    }
    for (const input of [
      `${header}; missing-equals`,
      `${header}; ${header}`,
      `${header}\nother=value`,
    ]) {
      await writeFile(file, input);
      await assert.rejects(
        manager.execute(owner, {
          op: "import_cookies",
          path: file,
          userApproved: true,
          format: "header",
          url: `https://${cookie.domain}`,
        }),
        (error) => safeError(error, secrets, /before submission/),
      );
      assert.equal(await readFile(file, "utf8"), input);
      await noBrowserState();
    }
    const controller = new AbortController();
    controller.abort(new Error(cookie.value));
    await assert.rejects(
      manager.execute(
        owner,
        { op: "import_cookies", path: file, userApproved: true },
        controller.signal,
      ),
      (error) => safeError(error, secrets, /cancelled/),
    );
    await noBrowserState();
  } finally {
    await manager.dispose();
    await rm(dirname(home.socketDirectory), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

it("imports scoped authentication, checkpoints privately, and restores it without replacing existing storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pico-cookie-import-"));
  const root = join(directory, "pico");
  const file = join(directory, "cookies.json");
  const host = "cookie-import.localhost";
  const auth = `synthetic-auth-${crypto.randomUUID()}`;
  const expires = Math.floor(Date.now() / 1000) + 86_400;
  const cookies = [
    {
      name: "import-auth",
      value: auth,
      domain: `.${host}`,
      hostOnly: true,
      path: "/private",
      httpOnly: true,
      sameSite: "lax",
      expirationDate: expires,
    },
    {
      name: "host",
      value: "only",
      domain: `.${host}`,
      hostOnly: true,
      session: true,
      expirationDate: expires,
    },
    {
      name: "shared",
      value: "subdomains",
      domain: host,
      hostOnly: false,
      expires,
      sameSite: "STRICT",
    },
    { name: "empty", value: "", domain: host },
    { name: "session", value: "kept", domain: host, expires: -1 },
    { name: "expired", value: "gone", domain: host, expirationDate: 1 },
    {
      name: "secure-metadata",
      value: "synthetic",
      domain: "secure.example.test",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
      expirationDate: expires,
    },
  ];
  const input = JSON.stringify({ cookies });
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("/auth")) {
        const header = (request.headers.get("cookie") ?? "").split(/;\s*/);
        return Response.json({
          auth: header.includes(`import-auth=${auth}`),
          host: header.includes("host=only"),
          shared: header.includes("shared=subdomains"),
          empty: header.includes("empty="),
          session: header.includes("session=kept"),
          expired: header.includes("expired=gone"),
          existing: header.includes("existing=kept"),
        });
      }
      return new Response("<!doctype html><title>Cookie import fixture</title><p>Local login</p>", {
        headers: { "Content-Type": "text/html" },
      });
    },
  });
  const url = `http://${host}:${site.port}/`;
  const home = await prepareBrowserHome(root);
  const manager = await makeAgentBrowserManager({ root, idleTimeoutMs: 60_000 });
  const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000007");
  const main = { chatId, instance: { kind: "main" } } as const;
  const child = { chatId, instance: { kind: "child", sessionId: "cookie-child" } } as const;
  const later = {
    chatId: ChatId.make("018f47a0-0000-7000-8000-000000000008"),
    instance: { kind: "main" },
  } as const;
  const session = browserKey(JSON.stringify([chatId, "main"]));
  const statePath = join(home.stateDirectory, `${session}-${session}.json`);
  const seedPath = join(home.directory, "login-seed.json");
  const evaluate = async (owner: AgentBrowserOwner, script: string) => {
    const [result] = await manager.execute(owner, { op: "eval", script });
    if (result?.type !== "text") throw new Error("Missing page result");
    return Schema.decodeUnknownSync(Result)(JSON.parse(result.text)).result;
  };
  const readAuth = async (owner: AgentBrowserOwner, path = "/private/auth") =>
    Schema.decodeUnknownSync(CookieState)(
      JSON.parse(
        await evaluate(
          owner,
          `(async () => JSON.stringify(await (await fetch(${JSON.stringify(path)})).json()))()`,
        ),
      ),
    );
  const expected = {
    auth: true,
    host: true,
    shared: true,
    empty: true,
    session: true,
    expired: false,
    existing: true,
  };
  try {
    await writeFile(file, input, { mode: 0o600 });
    await manager.execute(main, { op: "open", url });
    await manager.execute(child, { op: "open", url });
    await evaluate(
      main,
      "document.cookie='existing=kept; path=/';localStorage.setItem('before','kept');'ready'",
    );
    await manager.execute(main, { op: "remember_login", userApproved: true });
    const seedBefore = await readFile(seedPath, "utf8");
    const result = await manager.execute(main, {
      op: "import_cookies",
      path: file,
      userApproved: true,
    });
    const [receipt] = result;
    if (receipt?.type !== "text") throw new Error("Missing import receipt");
    assert.deepEqual(JSON.parse(receipt.text), { submitted: cookies.length, checkpointed: true });
    assert.equal(result.length, 1);
    assert.equal(await readFile(file, "utf8"), input);
    assert.equal(await readFile(seedPath, "utf8"), seedBefore);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    const saved = Schema.decodeUnknownSync(SavedState)(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    const savedAuth = saved.cookies.find((cookie) => cookie.name === "import-auth");
    assert.equal(savedAuth?.expires, expires);
    assert.equal(savedAuth?.sameSite, "Lax");
    assert.equal(savedAuth?.httpOnly, true);
    assert.equal(savedAuth?.path, "/private");
    assert.equal(saved.cookies.find((cookie) => cookie.name === "host")?.session, true);
    const secure = saved.cookies.find((cookie) => cookie.name === "secure-metadata");
    assert.equal(secure?.secure, true);
    assert.equal(secure?.httpOnly, true);
    assert.equal(secure?.sameSite, "None");
    assert.deepEqual(await readAuth(main), expected);
    assert.deepEqual(await readAuth(main, "/public/auth"), { ...expected, auth: false });
    await manager.execute(main, { op: "open", url: `${url}private/` });
    const visible = await evaluate(main, "document.cookie");
    assert.ok(!visible.includes("import-auth"));
    assert.ok(!visible.includes(auth));
    assert.equal(await evaluate(main, "localStorage.getItem('before')"), "kept");
    assert.equal((await readAuth(child)).auth, false);
    assert.equal((await readAuth(child)).shared, false);
    await manager.execute(later, { op: "open", url });
    assert.deepEqual(await readAuth(later), {
      auth: false,
      host: false,
      shared: false,
      empty: false,
      session: false,
      expired: false,
      existing: true,
    });
    await manager.execute(main, { op: "open", url: `http://child.${host}:${site.port}/` });
    assert.deepEqual(await readAuth(main), {
      auth: false,
      host: false,
      shared: true,
      empty: false,
      session: false,
      expired: false,
      existing: false,
    });
    await manager.execute(main, { op: "open", url });
    await manager.execute(main, { op: "close" });
    await manager.execute(main, { op: "open", url });
    assert.deepEqual(await readAuth(main), expected);
    assert.equal(await evaluate(main, "localStorage.getItem('before')"), "kept");
    await manager.execute(main, { op: "open", url: `http://child.${host}:${site.port}/` });
    assert.deepEqual(await readAuth(main), {
      auth: false,
      host: false,
      shared: true,
      empty: false,
      session: false,
      expired: false,
      existing: false,
    });
    await manager.execute(main, { op: "close" });
    await writeFile(statePath, "synthetic corrupt saved state");
    await manager.execute(main, { op: "import_cookies", path: file, userApproved: true });
    await manager.execute(main, { op: "open", url });
    assert.equal((await readAuth(main)).auth, true);
    await manager.execute(main, { op: "close" });
    await manager.execute(main, { op: "open", url });
    assert.equal((await readAuth(main)).auth, true);
    assert.equal(await readFile(seedPath, "utf8"), seedBefore);
    assert.equal(await readFile(file, "utf8"), input);
  } finally {
    await manager.dispose();
    await site.stop(true);
    await rm(dirname(home.socketDirectory), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

it("imports a copied header before navigation and restores host-only login with JavaScript CSRF access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pico-cookie-header-"));
  const root = join(directory, "pico");
  const file = join(directory, "cookies.txt");
  const secureFile = join(directory, "secure-cookies.txt");
  const host = "cookie-header.localhost";
  const auth = `synthetic-${crypto.randomUUID()}==embedded=`;
  const csrf = "%2B%3D+literal";
  const pairs = [`auth=${auth}`, `csrf=${csrf}`, "empty="];
  const input = `\nCookie: ${pairs.join("; ")};\n`;
  const observed = new Map<string, boolean[]>();
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const header = (request.headers.get("cookie") ?? "").split(/;\s*/);
      const destination = new URL(request.url);
      if (destination.pathname === "/")
        observed.set(
          destination.hostname,
          pairs.map((pair) => header.includes(pair)),
        );
      return new Response("<!doctype html><title>Header login fixture</title><p>Local login</p>", {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
      });
    },
  });
  const url = `http://${host}:${site.port}/`;
  const home = await prepareBrowserHome(root);
  const manager = await makeAgentBrowserManager({ root, idleTimeoutMs: 60_000 });
  const chatId = ChatId.make("018f47a0-0000-7000-8000-00000000000a");
  const main = { chatId, instance: { kind: "main" } } as const;
  const child = { chatId, instance: { kind: "child", sessionId: "header-child" } } as const;
  const session = browserKey(JSON.stringify([chatId, "main"]));
  const statePath = join(home.stateDirectory, `${session}-${session}.json`);
  const seedPath = join(home.directory, "login-seed.json");
  const csrfVisible = async () => {
    const [result] = await manager.execute(main, {
      op: "eval",
      script: `document.cookie.split(/;\\s*/).includes(${JSON.stringify(`csrf=${csrf}`)}) ? 'visible' : 'missing'`,
    });
    if (result?.type !== "text") throw new Error("Missing page result");
    return Schema.decodeUnknownSync(Result)(JSON.parse(result.text)).result;
  };
  try {
    await writeFile(file, input, { mode: 0o600 });
    const result = await manager.execute(main, {
      op: "import_cookies",
      path: file,
      format: "header",
      url: `${url}private?ignored#fragment`,
      userApproved: true,
    });
    const [receipt] = result;
    if (receipt?.type !== "text") throw new Error("Missing import receipt");
    assert.deepEqual(JSON.parse(receipt.text), { submitted: pairs.length, checkpointed: true });
    assert.equal(result.length, 1);
    assert.equal(await readFile(file, "utf8"), input);
    assert.equal(await Bun.file(seedPath).exists(), false);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    const saved = Schema.decodeUnknownSync(SavedState)(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    const savedAuth = saved.cookies.find((cookie) => cookie.name === "auth");
    assert.equal(savedAuth?.domain, host);
    assert.equal(savedAuth?.session, true);
    assert.equal(savedAuth?.secure, false);
    await manager.execute(main, { op: "open", url });
    assert.deepEqual(observed.get(host), [true, true, true]);
    assert.equal(await csrfVisible(), "visible");
    for (const isolatedHost of [`child.${host}`, "sibling.localhost"]) {
      await manager.execute(main, {
        op: "open",
        url: `http://${isolatedHost}:${site.port}/`,
      });
      assert.deepEqual(observed.get(isolatedHost), [false, false, false]);
    }
    await manager.execute(child, { op: "open", url });
    assert.deepEqual(observed.get(host), [false, false, false]);
    const secureNames = ["__Http-auth", "__Host-Http-auth"];
    await writeFile(
      secureFile,
      [...secureNames.map((name) => `${name}=${auth}`), `csrf=${csrf}`].join("; "),
      { mode: 0o600 },
    );
    await manager.execute(main, {
      op: "import_cookies",
      path: secureFile,
      format: "header",
      url: "https://secure.header-import.test/private",
      userApproved: true,
    });
    const httpsState = Schema.decodeUnknownSync(SavedState)(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    for (const name of secureNames) {
      const savedCookie = httpsState.cookies.find(
        (cookie) => cookie.name === name && cookie.domain === "secure.header-import.test",
      );
      assert.equal(savedCookie?.value, auth);
      assert.equal(savedCookie?.secure, true);
      assert.equal(savedCookie?.httpOnly, true);
      assert.equal(savedCookie?.path, "/");
      assert.equal(savedCookie?.session, true);
    }
    const secureCsrf = httpsState.cookies.find(
      (cookie) => cookie.name === "csrf" && cookie.domain === "secure.header-import.test",
    );
    assert.equal(secureCsrf?.value, csrf);
    assert.equal(secureCsrf?.secure, true);
    assert.equal(secureCsrf?.httpOnly, false);
    assert.equal(secureCsrf?.session, true);
    await manager.execute(main, { op: "close" });
    observed.clear();
    await manager.execute(main, { op: "open", url });
    assert.deepEqual(observed.get(host), [true, true, true]);
    assert.equal(await csrfVisible(), "visible");
    await manager.execute(main, { op: "open", url: `http://child.${host}:${site.port}/` });
    assert.deepEqual(observed.get(`child.${host}`), [false, false, false]);
    assert.equal(await readFile(file, "utf8"), input);
    assert.equal(await Bun.file(seedPath).exists(), false);
  } finally {
    await manager.dispose();
    await site.stop(true);
    await rm(dirname(home.socketDirectory), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

const Command = Schema.Struct({ action: Schema.String, path: Schema.optionalKey(Schema.String) });

for (const failure of [
  "startup",
  "setter",
  "acknowledgment",
  "checkpoint",
  "recovery",
  "cancelled",
] as const) {
  it(`redacts ${failure} failures and reports cookie mutation uncertainty without replay`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-cookie-failure-"));
    const root = join(directory, "pico");
    const file = join(directory, "private-path-sentinel.json");
    const name = "private-name-sentinel";
    const value = "private-value-sentinel";
    const domain = "private-domain-sentinel.test";
    const home = await prepareBrowserHome(root);
    const manager = await makeAgentBrowserManager({ root, idleTimeoutMs: 60_000 });
    const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000009");
    const owner = { chatId, instance: { kind: "main" } } as const;
    const session = browserKey(JSON.stringify([chatId, "main"]));
    const statePath = join(home.stateDirectory, `${session}-${session}.json`);
    const controller = new AbortController();
    const secrets = [file, basename(file), name, value, domain];
    const nativeError = secrets.join(" ");
    const sockets = new Set<Socket>();
    let submissions = 0;
    let fixtureError: unknown;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        const respond = async () => {
          const command = Schema.decodeUnknownSync(Command)(JSON.parse(input.trim()));
          const success = (data: unknown) =>
            socket.end(`${JSON.stringify({ success: true, data })}\n`);
          const fail = () =>
            socket.end(`${JSON.stringify({ success: false, error: nativeError })}\n`);
          switch (command.action) {
            case "stream_status":
              if (failure === "startup") return fail();
              return success({ enabled: true, connected: true, port: 1 });
            case "session_info":
              return success({
                browserLaunched: true,
                restoreStatus: failure === "recovery" ? "load_failed" : "none",
                backgroundPid: process.pid,
              });
            case "cookies_set":
              submissions++;
              if (failure === "setter") return fail();
              if (failure === "acknowledgment") return success({ set: nativeError });
              if (failure === "cancelled") {
                controller.abort(new Error(nativeError));
                return;
              }
              return success({ set: true });
            case "state_save":
              if (failure === "checkpoint") return fail();
              assert.ok(command.path);
              await writeFile(command.path, JSON.stringify({ cookies: [], origins: [] }));
              return success({ saved: true, path: command.path });
            case "state_load":
              return fail();
            case "close":
              return success({ closed: true });
            default:
              throw new Error(`Unexpected fixture command ${command.action}`);
          }
        };
        void respond().catch((error: unknown) => {
          fixtureError = error;
          socket.destroy();
        });
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(home.socketDirectory, `${session}.sock`), resolve);
      });
      await writeFile(file, JSON.stringify([{ name, value, domain }]));
      const outcome =
        failure === "startup"
          ? /before submission/
          : failure === "checkpoint" || failure === "recovery"
            ? /submitted.*could not be confirmed/
            : /outcome is uncertain/;
      await assert.rejects(
        manager.execute(
          owner,
          { op: "import_cookies", path: file, userApproved: true },
          controller.signal,
        ),
        (error) => safeError(error, secrets, outcome),
      );
      assert.equal(submissions, failure === "startup" ? 0 : 1);
      assert.equal(fixtureError, undefined);
      assert.equal(await Bun.file(statePath).exists(), failure === "recovery");
      assert.equal(await Bun.file(join(home.directory, "login-seed.json")).exists(), false);
      assert.equal(await readFile(file, "utf8"), JSON.stringify([{ name, value, domain }]));
    } finally {
      await manager.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dirname(home.socketDirectory), { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
}
