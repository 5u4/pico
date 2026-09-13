import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { expect, vi } from "vitest";
import { launchBrowser, prepareBrowserHome, sendBrowserCommand } from "./browser-cli.ts";
import { type BrowserTabsRequest, makeBrowserViewer } from "./browser-viewer.ts";

const connected = { type: "status", connected: true };
const ready = { type: "viewer_ready" };
const browserTabs = {
  tabs: [
    { tabId: "t1", title: "Login", url: "https://login.example.test/", active: true },
    { tabId: "t2", title: "Popup", url: "https://popup.example.test/", active: false },
  ],
};
const keyDown = {
  type: "input_keyboard",
  eventType: "keyDown",
  key: "A",
  code: "KeyA",
  text: "A",
  windowsVirtualKeyCode: 65,
  modifiers: 8,
};
const mouseDown = {
  type: "input_mouse",
  eventType: "mousePressed",
  x: 40,
  y: 60,
  button: "left",
  clickCount: 1,
  modifiers: 8,
  deltaX: 0,
  deltaY: 0,
};
type NativeConnection = { messages: unknown[]; closed: boolean };

const bounded = async <T>(promise: Promise<T>, label: string, timeout = 5_000) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const fixture = (handshake: () => Promise<void> = async () => {}) => {
  const nativeSockets: Bun.ServerWebSocket<NativeConnection>[] = [];
  const nativeRequests: string[] = [];
  const native = Bun.serve<NativeConnection>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      nativeRequests.push(new URL(request.url).search);
      await handshake();
      if (server.upgrade(request, { data: { messages: [], closed: false } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        nativeSockets.push(socket);
        socket.send(JSON.stringify(connected));
      },
      message(socket, message) {
        socket.data.messages.push(JSON.parse(message.toString()));
      },
      close(socket) {
        socket.data.closed = true;
      },
    },
  });
  const port = native.port;
  assert.ok(port !== undefined);
  const viewer = makeBrowserViewer();
  const clients: WebSocket[] = [];
  return {
    viewer,
    nativeSockets,
    nativeRequests,
    expose(options: Partial<Parameters<typeof viewer.expose>[0]> = {}) {
      return viewer.expose({
        port,
        identity: 1,
        previous: undefined,
        valid: async () => true,
        tabs: async () => browserTabs,
        ...options,
      });
    },
    connect(url: string, headers: Record<string, string> = { Origin: new URL(url).origin }) {
      const socket = new WebSocket(new URL("ws", url).href.replace(/^http/, "ws"), { headers });
      clients.push(socket);
      const messages: unknown[] = [];
      const state = { opened: false, closeCode: 0, messages };
      socket.addEventListener("open", () => {
        state.opened = true;
      });
      socket.addEventListener("message", (event) => {
        state.messages.push(JSON.parse(String(event.data)));
      });
      socket.addEventListener("close", (event) => {
        state.closeCode = event.code;
      });
      socket.addEventListener("error", () => {});
      return { socket, state };
    },
    async dispose() {
      for (const client of clients) client.close();
      try {
        await settled(() => {
          for (const client of clients) assert.equal(client.readyState, WebSocket.CLOSED);
          for (const socket of nativeSockets) assert.equal(socket.data.closed, true);
        });
      } finally {
        try {
          await bounded(viewer.dispose(), "Viewer shutdown");
        } finally {
          await bounded(native.stop(true), "Native fixture shutdown");
        }
      }
    },
  };
};

const http = async (url: string | URL, init?: RequestInit) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
  return { status: response.status, headers: response.headers, body: await response.text() };
};
const settled = (check: () => void) => vi.waitFor(check, { interval: 10, timeout: 5_000 });

it("authorizes viewer assets, tab control, and real websocket upgrades", async () => {
  const test = fixture();
  const requests: BrowserTabsRequest[] = [];
  const route = test.expose({
    tabs: async (request) => {
      requests.push(request);
      return request.action === "refresh"
        ? browserTabs
        : {
            tabs: browserTabs.tabs.map((tab) => ({ ...tab, active: tab.tabId === request.tabId })),
          };
    },
  });
  const origin = new URL(route.url).origin;
  const localhost = origin.replace("127.0.0.1", "localhost");
  const missing = new URL("../missing/", route.url).href;
  const refresh = JSON.stringify({ action: "refresh" });
  try {
    const page = await http(route.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(
      (await http(new URL("client.js", route.url))).headers.get("content-type"),
      "text/javascript",
    );
    assert.equal(
      (await http(route.url, { headers: { Host: new URL(localhost).host } })).status,
      200,
    );

    const deniedAssets: [string, Record<string, string>, number][] = [
      [route.url, { Host: "attacker.example.test" }, 403],
      [route.url, { Origin: "https://attacker.example.test" }, 403],
      [route.url, { Origin: localhost }, 403],
      [missing, {}, 404],
    ];
    for (const [url, headers, status] of deniedAssets) {
      assert.equal((await http(url, { headers })).status, status);
    }

    const control = new URL("tabs", route.url);
    const deniedControls: [URL, Record<string, string>, string, number][] = [
      [control, { "Content-Type": "application/json" }, refresh, 403],
      [
        control,
        { Origin: origin, Host: "attacker.example.test", "Content-Type": "application/json" },
        refresh,
        403,
      ],
      [control, { Origin: "null", "Content-Type": "application/json" }, refresh, 403],
      [control, { Origin: origin, "Content-Type": "text/plain" }, refresh, 403],
      [control, { Origin: origin, "Content-Type": "application/json" }, "{", 400],
      [
        control,
        { Origin: origin, "Content-Type": "application/json" },
        JSON.stringify({ action: "select", tabId: "other-session" }),
        400,
      ],
      [
        new URL("tabs", missing),
        { Origin: origin, "Content-Type": "application/json" },
        refresh,
        404,
      ],
    ];
    for (const [url, headers, body, status] of deniedControls) {
      assert.equal((await http(url, { method: "POST", headers, body })).status, status);
    }
    assert.deepEqual(requests, []);
    const refreshed = await http(control, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: refresh,
    });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(JSON.parse(refreshed.body), browserTabs);
    const selected = await http(control, {
      method: "POST",
      headers: {
        Origin: localhost,
        Host: new URL(localhost).host,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "select", tabId: "t2" }),
    });
    assert.equal(selected.status, 200);
    assert.deepEqual(JSON.parse(selected.body), {
      tabs: browserTabs.tabs.map((tab) => ({ ...tab, active: tab.tabId === "t2" })),
    });
    assert.deepEqual(requests, [{ action: "refresh" }, { action: "select", tabId: "t2" }]);

    const deniedSockets: [string, Record<string, string>][] = [
      [route.url, {}],
      [route.url, { Origin: "https://attacker.example.test" }],
      [route.url, { Origin: localhost }],
      [route.url, { Origin: origin, Host: "attacker.example.test" }],
      [missing, { Origin: origin }],
    ];
    for (const [url, headers] of deniedSockets) {
      const denied = test.connect(url, headers);
      await settled(() => assert.equal(denied.socket.readyState, WebSocket.CLOSED));
      assert.equal(denied.state.opened, false);
    }
    assert.deepEqual(test.nativeRequests, []);
    const allowedSockets: Record<string, string>[] = [
      { Origin: origin },
      { Origin: localhost, Host: new URL(localhost).host },
    ];
    for (const headers of allowedSockets) {
      const client = test.connect(route.url, headers);
      await settled(() => assert.deepEqual(client.state.messages, [ready, connected]));
    }
    assert.deepEqual(test.nativeRequests, ["?pacing=ack&maxFps=10", "?pacing=ack&maxFps=10"]);
  } finally {
    await test.dispose();
  }
});

it("proxies both directions and revokes one route with held inputs without closing its sibling", async () => {
  const test = fixture();
  const first = test.expose();
  const sibling = test.expose({ identity: 2 });
  try {
    const client = test.connect(first.url);
    await settled(() => assert.deepEqual(client.state.messages, [ready, connected]));
    const secondClient = test.connect(first.url);
    await settled(() => assert.deepEqual(secondClient.state.messages, [ready, connected]));
    const otherClient = test.connect(sibling.url);
    await settled(() => assert.deepEqual(otherClient.state.messages, [ready, connected]));
    const [upstream, secondUpstream, otherUpstream] = test.nativeSockets;
    assert.ok(upstream);
    assert.ok(secondUpstream);
    assert.ok(otherUpstream);
    const navigation = { type: "url", url: "https://login.example.test/continue" };
    upstream.send(JSON.stringify(navigation));
    await settled(() => assert.deepEqual(client.state.messages, [ready, connected, navigation]));
    const ack = { type: "ack", seq: 17 };
    for (const message of [ack, keyDown, mouseDown]) client.socket.send(JSON.stringify(message));
    await settled(() => assert.deepEqual(upstream.data.messages, [ack, keyDown, mouseDown]));

    test.viewer.revoke(first.token);
    await settled(() => {
      assert.equal(client.state.closeCode, 1001);
      assert.equal(secondClient.state.closeCode, 1001);
      assert.equal(secondUpstream.data.closed, true);
      assert.equal(upstream.data.closed, true);
      assert.deepEqual(upstream.data.messages, [
        ack,
        keyDown,
        mouseDown,
        { ...keyDown, eventType: "keyUp", text: "", modifiers: 0 },
        { ...mouseDown, eventType: "mouseReleased", modifiers: 0 },
      ]);
    });
    assert.equal((await http(first.url)).status, 404);
    assert.equal(
      (
        await http(new URL("tabs", first.url), {
          method: "POST",
          headers: { Origin: new URL(first.url).origin, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "refresh" }),
        })
      ).status,
      404,
    );
    const expired = test.connect(first.url);
    await settled(() => assert.equal(expired.socket.readyState, WebSocket.CLOSED));
    assert.equal(expired.state.opened, false);
    otherClient.socket.send(JSON.stringify(ack));
    otherUpstream.send(JSON.stringify(navigation));
    await settled(() => {
      assert.deepEqual(otherUpstream.data.messages, [ack]);
      assert.deepEqual(otherClient.state.messages, [ready, connected, navigation]);
    });
    assert.equal((await http(sibling.url)).status, 200);
    assert.equal(otherUpstream.data.closed, false);
  } finally {
    await test.dispose();
  }
});

it("rejects expired owners and closes invalid websocket input without forwarding it", async () => {
  const test = fixture();
  let valid = false;
  let controls = 0;
  const route = test.expose({
    valid: async () => valid,
    tabs: async () => {
      controls++;
      return browserTabs;
    },
  });
  try {
    const expired = test.connect(route.url);
    await settled(() => assert.equal(expired.socket.readyState, WebSocket.CLOSED));
    assert.equal(expired.state.opened, false);
    const control = await http(new URL("tabs", route.url), {
      method: "POST",
      headers: { Origin: new URL(route.url).origin, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    });
    assert.equal(control.status, 410);
    assert.equal(controls, 0);
    assert.deepEqual(test.nativeRequests, []);

    valid = true;
    const client = test.connect(route.url);
    await settled(() => assert.deepEqual(client.state.messages, [ready, connected]));
    const [upstream] = test.nativeSockets;
    assert.ok(upstream);
    client.socket.send(JSON.stringify({ ...mouseDown, x: "40" }));
    await settled(() => {
      assert.equal(client.state.closeCode, 1008);
      assert.equal(upstream.data.closed, true);
    });
    assert.deepEqual(upstream.data.messages, []);
  } finally {
    await test.dispose();
  }
});

it("the browser client retains unsent text across handshake and reconnect races and releases held input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-viewer-client-"));
  const handshake = Promise.withResolvers<void>();
  const verification = Promise.withResolvers<boolean>();
  const test = fixture(() => handshake.promise);
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response('<!doctype html><input id="target" autofocus>', {
        headers: { "Content-Type": "text/html" },
      }),
  });
  let validations = 0;
  const route = test.expose({
    valid: async () => (++validations === 2 ? verification.promise : true),
  });
  let home: Awaited<ReturnType<typeof prepareBrowserHome>> | undefined;
  let driver: WebSocket | undefined;
  let daemonPid: number | undefined;
  let targetDaemonPid: number | undefined;
  const session = "viewer-client";
  const targetSession = "viewer-target";
  try {
    home = await prepareBrowserHome(root);
    await bounded(launchBrowser(home, session, false, 60_000), "Browser launch", 30_000);
    daemonPid = Number(await Bun.file(join(home.socketDirectory, `${session}.pid`)).text());
    assert.ok(Number.isSafeInteger(daemonPid) && daemonPid > 0);
    const browserHome = home;
    const command = (value: Readonly<Record<string, unknown>>) =>
      sendBrowserCommand(browserHome, session, value, AbortSignal.timeout(5_000));
    await command({ action: "navigate", url: route.url });
    const evaluate = async (script: string) =>
      Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }))(
        await command({ action: "evaluate", script }),
      ).result;
    const state = `({
      value: document.querySelector('#text').value,
      disabled: document.querySelector('#text-form button[type=submit]').disabled
    })`;
    const submit =
      "document.querySelector('#text-form').dispatchEvent(new Event('submit', { cancelable: true }))";
    const retained = { value: "one-time-code", disabled: true };
    await settled(() => assert.equal(test.nativeRequests.length, 1));
    assert.equal(test.nativeSockets.length, 0);
    assert.deepEqual(
      await evaluate(
        `document.querySelector('#text').value = 'one-time-code'; ${submit}; ${state}`,
      ),
      retained,
    );
    handshake.resolve();
    await settled(() => {
      assert.equal(test.nativeSockets.length, 1);
      assert.equal(validations, 2);
    });
    const [unverified] = test.nativeSockets;
    assert.ok(unverified);
    assert.deepEqual(await evaluate(`${submit}; ${state}`), retained);
    assert.deepEqual(unverified.data.messages, []);
    assert.deepEqual(
      await evaluate(
        `globalThis.previousConnection = socket; document.querySelector('#disconnect').click(); ${submit}; ${state}`,
      ),
      retained,
    );
    assert.deepEqual(
      await evaluate(`document.querySelector('#connect').click(); ${submit}; ${state}`),
      retained,
    );
    await vi.waitFor(
      async () => assert.deepEqual(await evaluate(state), { ...retained, disabled: false }),
      { interval: 20, timeout: 5_000 },
    );
    verification.resolve(true);
    await settled(() => assert.equal(unverified.data.closed, true));
    assert.deepEqual(
      await evaluate(
        `previousConnection.onmessage(new MessageEvent('message', { data: JSON.stringify({ type: 'status', connected: false }) })); previousConnection.onclose(); previousConnection.onerror(); ${state}`,
      ),
      { ...retained, disabled: false },
    );
    const reconnected = test.nativeSockets[1];
    assert.ok(reconnected);
    assert.deepEqual(reconnected.data.messages, []);
    assert.deepEqual(await evaluate(`${submit}; ${state}`), { value: "", disabled: false });
    const characters = (value: string) =>
      Array.from(value, (character) => ({
        type: "input_keyboard",
        eventType: "char",
        key: "",
        code: "",
        text: character,
        windowsVirtualKeyCode: 0,
        modifiers: 0,
      }));
    await settled(() => assert.deepEqual(reconnected.data.messages, characters(retained.value)));
    reconnected.send(JSON.stringify({ ...connected, connected: false }));
    await vi.waitFor(
      async () => assert.deepEqual(await evaluate(state), { value: "", disabled: true }),
      { interval: 20, timeout: 5_000 },
    );
    assert.deepEqual(
      await evaluate(`document.querySelector('#text').value = 'next-code'; ${submit}; ${state}`),
      { value: "next-code", disabled: true },
    );
    reconnected.send(JSON.stringify(connected));
    await vi.waitFor(
      async () => assert.deepEqual(await evaluate(state), { value: "next-code", disabled: false }),
      { interval: 20, timeout: 5_000 },
    );
    assert.deepEqual(await evaluate(`socket.close(); ${submit}; ${state}`), {
      value: "next-code",
      disabled: true,
    });
    await settled(() => assert.equal(reconnected.data.closed, true));
    assert.deepEqual(reconnected.data.messages, characters(retained.value));
    await evaluate("document.querySelector('#connect').click()");
    await vi.waitFor(
      async () => assert.deepEqual(await evaluate(state), { value: "next-code", disabled: false }),
      { interval: 20, timeout: 5_000 },
    );
    const upstream = test.nativeSockets[2];
    assert.ok(upstream);
    assert.deepEqual(upstream.data.messages, []);
    assert.deepEqual(await evaluate(`${submit}; ${state}`), { value: "", disabled: false });
    await settled(() => assert.deepEqual(upstream.data.messages, characters("next-code")));
    upstream.data.messages.length = 0;
    const stream = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
      await command({ action: "stream_status" }),
    );
    driver = new WebSocket(`ws://127.0.0.1:${stream.port}/?pacing=ack`);
    driver.addEventListener("error", () => {});
    const inputSocket = driver;
    await settled(() => assert.equal(inputSocket.readyState, WebSocket.OPEN));
    const position = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
      }),
    )(
      await command({
        action: "evaluate",
        script:
          "(() => { const canvas = document.querySelector('#page'); canvas.focus(); const box = canvas.getBoundingClientRect(); return { x: box.x + 20, y: box.y + 20 }; })()",
      }),
    ).result;
    const input = (message: Readonly<Record<string, unknown>>) =>
      inputSocket.send(JSON.stringify(message));
    const shift = {
      ...keyDown,
      key: "Shift",
      code: "ShiftLeft",
      text: "",
      windowsVirtualKeyCode: 16,
    };
    const press = { ...mouseDown, ...position };
    input({ ...press, eventType: "mouseMoved", button: "none", modifiers: 0 });
    input(shift);
    input(press);
    await settled(() =>
      expect(upstream.data.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "input_keyboard", eventType: "keyDown", key: "Shift" }),
          expect.objectContaining({
            type: "input_mouse",
            eventType: "mousePressed",
            button: "left",
          }),
        ]),
      ),
    );
    await command({
      action: "evaluate",
      script: "document.querySelector('#page').blur()",
    });
    await settled(() =>
      expect(upstream.data.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "input_keyboard",
            eventType: "keyUp",
            key: "Shift",
            text: "",
            modifiers: 0,
          }),
          expect.objectContaining({
            type: "input_mouse",
            eventType: "mouseReleased",
            button: "left",
            modifiers: 0,
          }),
        ]),
      ),
    );
    assert.equal(upstream.data.closed, false);
    const navigation = { type: "url", url: "https://login.example.test/after-blur" };
    upstream.send(JSON.stringify(navigation));
    await vi.waitFor(
      async () => {
        const result = await command({
          action: "evaluate",
          script: "document.querySelector('#url').textContent",
        });
        assert.equal(
          Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }))(result).result,
          navigation.url,
        );
      },
      { interval: 20, timeout: 5_000 },
    );
    input({ ...shift, eventType: "keyUp", modifiers: 0 });
    input({ ...press, eventType: "mouseReleased", modifiers: 0 });
    await bounded(launchBrowser(home, targetSession, false, 60_000), "Target launch", 30_000);
    targetDaemonPid = Number(
      await Bun.file(join(home.socketDirectory, `${targetSession}.pid`)).text(),
    );
    assert.ok(Number.isSafeInteger(targetDaemonPid) && targetDaemonPid > 0);
    const targetCommand = (value: Readonly<Record<string, unknown>>) =>
      sendBrowserCommand(browserHome, targetSession, value, AbortSignal.timeout(5_000));
    await targetCommand({ action: "navigate", url: `http://127.0.0.1:${site.port}/` });
    await targetCommand({
      action: "evaluate",
      script: "document.querySelector('#target').focus()",
    });
    const targetStream = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
      await targetCommand({ action: "stream_status" }),
    );
    const targetRoute = test.expose({ port: targetStream.port, identity: targetDaemonPid });
    await command({ action: "navigate", url: targetRoute.url });
    await vi.waitFor(
      async () => assert.deepEqual(await evaluate(state), { value: "", disabled: false }),
      { interval: 20, timeout: 5_000 },
    );
    assert.deepEqual(
      await evaluate(
        `document.querySelector('#disconnect').click(); document.querySelector('#text').value = 'live-otp-123'; ${submit}; ${state}`,
      ),
      { value: "live-otp-123", disabled: true },
    );
    await evaluate("document.querySelector('#connect').click()");
    await vi.waitFor(
      async () =>
        assert.deepEqual(await evaluate(state), { value: "live-otp-123", disabled: false }),
      { interval: 20, timeout: 5_000 },
    );
    const targetValue = async () =>
      Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }))(
        await targetCommand({
          action: "evaluate",
          script: "document.querySelector('#target').value",
        }),
      ).result;
    assert.equal(await targetValue(), "");
    assert.deepEqual(await evaluate(`${submit}; ${state}`), { value: "", disabled: false });
    await vi.waitFor(async () => assert.equal(await targetValue(), "live-otp-123"), {
      interval: 20,
      timeout: 5_000,
    });
    assert.deepEqual(
      await evaluate(
        `document.querySelector('#text').value = 'failed-code'; socket.send = () => { throw new Error('transport failed'); }; ${submit}; ${state}`,
      ),
      { value: "failed-code", disabled: true },
    );
    assert.equal(await targetValue(), "live-otp-123");
    await evaluate("document.querySelector('#connect').click()");
    await vi.waitFor(
      async () =>
        assert.deepEqual(await evaluate(state), { value: "failed-code", disabled: false }),
      { interval: 20, timeout: 5_000 },
    );
    await evaluate("document.querySelector('#text').value = 'revoked-code'");
    test.viewer.revoke(targetRoute.token);
    await vi.waitFor(
      async () =>
        assert.deepEqual(await evaluate(state), { value: "revoked-code", disabled: true }),
      { interval: 20, timeout: 5_000 },
    );
    assert.deepEqual(await evaluate(`${submit}; ${state}`), {
      value: "revoked-code",
      disabled: true,
    });
    assert.equal(await targetValue(), "live-otp-123");
  } finally {
    handshake.resolve();
    verification.resolve(false);
    driver?.close();
    try {
      if (home) {
        const daemons: [string, number | undefined][] = [[session, daemonPid]];
        if (targetDaemonPid !== undefined) daemons.push([targetSession, targetDaemonPid]);
        for (const [name, pid] of daemons) {
          await sendBrowserCommand(home, name, { action: "close" }, AbortSignal.timeout(5_000));
          const socketDirectory = home.socketDirectory;
          await vi.waitFor(
            async () => {
              assert.equal(await Bun.file(join(socketDirectory, `${name}.pid`)).exists(), false);
              assert.equal(await Bun.file(join(socketDirectory, `${name}.sock`)).exists(), false);
              if (pid !== undefined) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
            },
            { interval: 20, timeout: 5_000 },
          );
        }
        if (driver) await settled(() => assert.equal(driver?.readyState, WebSocket.CLOSED));
      }
    } finally {
      try {
        await test.dispose();
      } finally {
        if (home) await rm(dirname(home.socketDirectory), { recursive: true, force: true });
        await site.stop(true);
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
