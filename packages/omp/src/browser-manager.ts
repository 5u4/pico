import { constants } from "node:fs";
import { chmod, copyFile, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { ChatId } from "@pico/contract/chat-model";
import type { BrowserConfig } from "@pico/contract/config";
import * as Schema from "effect/Schema";
import {
  BrowserUnavailable,
  browserKey,
  launchBrowser,
  prepareBrowserHome,
  sendBrowserCommand,
} from "./browser-cli.ts";
import type { BrowserOperation } from "./browser-extension.ts";
import { BrowserTabs, type BrowserTabsRequest, makeBrowserViewer } from "./browser-viewer.ts";

export interface BrowserOwner {
  readonly chatId: ChatId;
  readonly instance:
    | { readonly kind: "main" }
    | { readonly kind: "child"; readonly sessionId: string };
}
const PendingMode = Schema.Struct({
  mode: Schema.Literals(["headless", "headed"]),
  cdpUrl: Schema.String,
});
const Cdp = Schema.Struct({ cdpUrl: Schema.String });
const Manifest = Schema.Struct({
  chatId: Schema.String,
  session: Schema.String.check(Schema.isPattern(/^[a-f0-9]{24}$/)),
  mode: Schema.Literals(["headless", "headed"]),
  pendingMode: Schema.optionalKey(PendingMode),
});
const Info = Schema.Struct({
  browserLaunched: Schema.Boolean,
  restoreStatus: Schema.String,
  backgroundPid: Schema.Int.check(Schema.isGreaterThan(0)),
});
const Stream = Schema.Struct({
  enabled: Schema.Boolean,
  connected: Schema.Boolean,
  port: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
});
const Save = Schema.Struct({ saved: Schema.Literal(true), path: Schema.String });
const Close = Schema.Struct({
  closed: Schema.Literal(true),
  saveStatus: Schema.optionalKey(Schema.String),
  saveError: Schema.optionalKey(Schema.String),
});
const Storage = Schema.Struct({
  cookies: Schema.Array(Schema.Unknown),
  origins: Schema.Array(
    Schema.Struct({
      origin: Schema.String,
      localStorage: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    }),
  ),
});
type Entry = {
  readonly chatId: string;
  readonly session: string;
  mode: "headless" | "headed";
  pendingMode: typeof PendingMode.Type | undefined;
  state: "available" | "closing";
  generation: number;
  queue: Promise<void>;
  viewer: { token: string; url: string } | undefined;
};
const text = (value: unknown): TextContent => ({
  type: "text",
  text: typeof value === "string" ? value : (JSON.stringify(value) ?? "null"),
});
const failedRestore = (status: string) =>
  status === "load_failed" || status === "loaded_but_invalid";
const missingFile = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const makeBrowserManager = async ({
  root,
  idleTimeoutMs,
}: { readonly root: string } & BrowserConfig) => {
  const home = await prepareBrowserHome(root);
  const entries = new Map<string, Entry>();
  const archived = new Set<string>();
  const viewer = makeBrowserViewer();
  let disposed = false;
  let disposing: Promise<void> | undefined;
  const seed = join(home.directory, "login-seed.json");
  const ownerDirectory = join(home.directory, "owners");
  const manifestPath = (entry: Entry) => join(ownerDirectory, `${entry.session}.json`);
  const statePath = (entry: Entry) =>
    join(home.stateDirectory, `${entry.session}-${entry.session}.json`);
  const persist = async (entry: Entry) => {
    const candidate = `${manifestPath(entry)}.tmp`;
    try {
      await writeFile(
        candidate,
        JSON.stringify({
          chatId: entry.chatId,
          session: entry.session,
          mode: entry.mode,
          pendingMode: entry.pendingMode,
        }),
        { mode: 0o600 },
      );
      await rename(candidate, manifestPath(entry));
    } finally {
      await rm(candidate, { force: true });
    }
  };
  const reconcileMode = async (entry: Entry, browserConnected: boolean, signal?: AbortSignal) => {
    if (!entry.pendingMode) return;
    // An interrupted restart can finish in the daemon. Observe its browser identity; do not replay it.
    if (browserConnected) {
      const { cdpUrl } = Schema.decodeUnknownSync(Cdp)(
        await sendBrowserCommand(home, entry.session, { action: "cdp_url" }, signal),
      );
      if (cdpUrl !== entry.pendingMode.cdpUrl) entry.mode = entry.pendingMode.mode;
    }
    entry.pendingMode = undefined;
    await persist(entry);
  };
  const makeEntry = (chatId: string, session: string, mode: Entry["mode"]): Entry => ({
    chatId,
    session,
    mode,
    pendingMode: undefined,
    state: "available",
    generation: 0,
    queue: Promise.resolve(),
    viewer: undefined,
  });
  for (const file of await readdir(ownerDirectory)) {
    if (!/^[a-f0-9]{24}\.json$/.test(file)) continue;
    const saved = Schema.decodeUnknownSync(Manifest)(
      JSON.parse(await readFile(join(ownerDirectory, file), "utf8")),
    );
    if (file !== `${saved.session}.json`) throw new Error("Invalid browser owner manifest");
    const entry = makeEntry(saved.chatId, saved.session, saved.mode);
    entry.pendingMode = saved.pendingMode;
    entries.set(saved.session, entry);
  }
  // This queue serializes local waits. A cancelled or timed-out native command may still be running.
  const enqueue = <A>(entry: Entry, operation: () => Promise<A>): Promise<A> => {
    const pending = entry.queue.then(operation);
    entry.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  const revoke = (entry: Entry) => {
    if (entry.viewer) viewer.revoke(entry.viewer.token);
    entry.viewer = undefined;
  };
  const closeEntry = async (entry: Entry, signal?: AbortSignal) => {
    revoke(entry);
    try {
      const result = Schema.decodeUnknownSync(Close)(
        await sendBrowserCommand(home, entry.session, { action: "close" }, signal),
      );
      const deadline = Date.now() + 5_000;
      while (await Bun.file(join(home.socketDirectory, `${entry.session}.pid`)).exists()) {
        if (Date.now() >= deadline) throw new Error("Browser closed but its daemon did not exit");
        await Bun.sleep(20);
      }
      if (
        result.saveError ||
        result.saveStatus === "error" ||
        result.saveStatus === "skipped_restore_failed"
      )
        throw new Error(
          "Browser closed, but login state was not saved. Previous saved credentials were retained.",
        );
    } catch (error) {
      if (!(error instanceof BrowserUnavailable)) throw error;
    }
  };
  const checkpoint = async (entry: Entry, recover: boolean, signal?: AbortSignal) => {
    const info = Schema.decodeUnknownSync(Info)(
      await sendBrowserCommand(home, entry.session, { action: "session_info" }, signal),
    );
    if (!recover && failedRestore(info.restoreStatus))
      throw new Error(
        "Restore failed. Complete login and use checkpoint before changing mode; the live browser has not been closed.",
      );
    const candidate = join(home.stateDirectory, `.checkpoint-${crypto.randomUUID()}.json`);
    await writeFile(candidate, "", { mode: 0o600 });
    try {
      const saved = Schema.decodeUnknownSync(Save)(
        await sendBrowserCommand(
          home,
          entry.session,
          { action: "state_save", path: candidate },
          signal,
        ),
      );
      if (saved.path !== candidate) throw new Error("Browser saved state outside its checkpoint");
      Schema.decodeUnknownSync(Storage)(JSON.parse(await readFile(candidate, "utf8")));
      await chmod(candidate, 0o600);
      await rename(candidate, statePath(entry));
      if (failedRestore(info.restoreStatus))
        await sendBrowserCommand(
          home,
          entry.session,
          { action: "state_load", path: statePath(entry) },
          signal,
        );
    } finally {
      await rm(candidate, { force: true });
    }
  };
  const expose = async (entry: Entry, signal?: AbortSignal) => {
    const stream = Schema.decodeUnknownSync(Stream)(
      await sendBrowserCommand(home, entry.session, { action: "stream_status" }, signal),
    );
    if (!stream.enabled || !stream.connected || stream.port === null)
      throw new Error("Browser has no live viewer stream");
    const info = Schema.decodeUnknownSync(Info)(
      await sendBrowserCommand(home, entry.session, { action: "session_info" }, signal),
    );
    const ownerAvailable = () =>
      !disposed && !archived.has(entry.chatId) && entry.state !== "closing";
    const valid = async () => {
      if (!ownerAvailable()) return false;
      try {
        const [pid, port] = await Promise.all([
          readFile(join(home.socketDirectory, `${entry.session}.pid`), "utf8"),
          readFile(join(home.socketDirectory, `${entry.session}.stream`), "utf8"),
        ]);
        if (Number(pid.trim()) !== info.backgroundPid || Number(port.trim()) !== stream.port)
          return false;
        process.kill(info.backgroundPid, 0);
        return ownerAvailable();
      } catch {
        return false;
      }
    };
    const tabs = (request: BrowserTabsRequest) => {
      const generation = entry.generation;
      return enqueue(entry, async () => {
        const check = async () => {
          if (!(await valid()) || entry.generation !== generation)
            throw new Error("Browser viewer expired");
        };
        await check();
        if (request.action === "select") {
          await sendBrowserCommand(home, entry.session, {
            action: "tab_switch",
            tabId: request.tabId,
          });
          await check();
        }
        const result = Schema.decodeUnknownSync(BrowserTabs)(
          await sendBrowserCommand(home, entry.session, { action: "tab_list" }),
        );
        await check();
        return result;
      });
    };
    entry.viewer = viewer.expose({
      port: stream.port,
      identity: info.backgroundPid,
      valid,
      tabs,
      previous: entry.viewer?.token,
    });
    return entry.viewer.url;
  };
  const execute = (
    owner: BrowserOwner,
    operation: BrowserOperation,
    signal?: AbortSignal,
  ): Promise<Array<TextContent | ImageContent>> => {
    if (disposed || archived.has(owner.chatId))
      return Promise.reject(new Error("Browser owner is closed"));
    if (signal?.aborted) return Promise.reject(new Error("Browser operation cancelled"));
    if (operation.op === "mode" && operation.userRequested !== true)
      return Promise.reject(
        new Error("Browser mode changes require an explicit user request and userRequested:true."),
      );
    if (operation.op === "remember_login" && operation.userApproved !== true)
      return Promise.reject(
        new Error("Remembering logins requires explicit user approval and userApproved:true."),
      );
    if (operation.op === "upload") {
      if (operation.userApproved !== true)
        return Promise.reject(
          new Error("File uploads require explicit user approval and userApproved:true."),
        );
      if (operation.files.some((file) => !isAbsolute(file)))
        return Promise.reject(new Error("Upload paths must be absolute"));
    }
    if (
      (operation.op === "open" || (operation.op === "tabs" && operation.action === "new")) &&
      operation.url !== undefined
    ) {
      const destination = URL.parse(operation.url);
      if (destination?.protocol === "file:") {
        if (operation.userRequested !== true)
          return Promise.reject(
            new Error(
              "Local file previews require an explicit user request and userRequested:true.",
            ),
          );
        operation = { ...operation, url: destination.href };
      }
    }
    const session = browserKey(
      JSON.stringify([
        owner.chatId,
        owner.instance.kind === "main" ? "main" : owner.instance.sessionId,
      ]),
    );
    let entry = entries.get(session);
    if (!entry) {
      entry = makeEntry(owner.chatId, session, "headless");
      entries.set(session, entry);
    }
    const current = entry;
    if (current.state === "closing")
      return Promise.reject(new Error("Browser is closing or changing mode"));
    if (operation.op === "close" || operation.op === "mode") {
      current.state = "closing";
      current.generation++;
    }
    const generation = current.generation;
    const ownerClosed = () =>
      disposed || archived.has(current.chatId) || current.generation !== generation;
    const check = () => {
      if (ownerClosed()) throw new Error("Browser operation cancelled because its owner closed");
      if (signal?.aborted)
        throw new Error(
          "Browser operation cancelled; the command outcome is uncertain. The native command may still run; inspect the page before retrying.",
        );
    };
    return enqueue(current, async () => {
      try {
        check();
        if (operation.op === "close") {
          await closeEntry(current, signal);
          return [text("Browser closed. Saved login state retained.")];
        }
        const exists = await Bun.file(manifestPath(current)).exists();
        if (!exists) {
          try {
            await copyFile(seed, statePath(current), constants.COPYFILE_EXCL);
            await chmod(statePath(current), 0o600);
          } catch (error) {
            if (
              !missingFile(error) &&
              !(error instanceof Error && "code" in error && error.code === "EEXIST")
            )
              throw error;
          }
          await persist(current);
        }
        check();
        let browserConnected = false;
        try {
          browserConnected = Schema.decodeUnknownSync(Stream)(
            await sendBrowserCommand(home, current.session, { action: "stream_status" }, signal),
          ).connected;
        } catch (error) {
          if (!(error instanceof BrowserUnavailable)) throw error;
        }
        check();
        // Native dialogs block the identity query until they are handled.
        if (operation.op !== "dialog") {
          await reconcileMode(current, browserConnected, signal);
          check();
        }
        try {
          if (!browserConnected)
            await launchBrowser(
              home,
              current.session,
              current.mode === "headed",
              idleTimeoutMs,
              signal,
            );
          check();
        } catch (error) {
          if (ownerClosed()) await closeEntry(current);
          throw error;
        }
        if (operation.op === "mode") {
          if (current.mode !== operation.mode) {
            await checkpoint(current, false, signal);
            check();
            const { cdpUrl } = Schema.decodeUnknownSync(Cdp)(
              await sendBrowserCommand(home, current.session, { action: "cdp_url" }, signal),
            );
            current.pendingMode = { mode: operation.mode, cdpUrl };
            await persist(current);
            check();
            revoke(current);
            try {
              await launchBrowser(
                home,
                current.session,
                operation.mode === "headed",
                idleTimeoutMs,
                signal,
              );
              current.mode = operation.mode;
              current.pendingMode = undefined;
              await persist(current);
              check();
            } catch (error) {
              if (ownerClosed()) await closeEntry(current);
              throw error;
            }
          }
          const viewerUrl = await expose(current, signal);
          check();
          return [
            text({
              mode: current.mode,
              viewerUrl,
              note: "Mode changes restart the browser. Take a fresh snapshot; transient page state may be lost.",
            }),
          ];
        }
        if (operation.op === "checkpoint" || operation.op === "remember_login") {
          await checkpoint(current, true, signal);
          check();
          if (operation.op === "remember_login") {
            const candidate = join(home.directory, `.seed-${crypto.randomUUID()}.json`);
            try {
              await copyFile(statePath(current), candidate);
              await chmod(candidate, 0o600);
              check();
              await rename(candidate, seed);
            } finally {
              await rm(candidate, { force: true });
            }
          }
          return [
            text(
              operation.op === "remember_login"
                ? "Published all saved sites as the login seed. Only new browser owners copy it; existing owners keep their own state."
                : "Saved this browser's login state.",
            ),
          ];
        }
        const content: Array<TextContent | ImageContent> = [];
        if (operation.op === "screenshot") {
          const path = join(
            home.directory,
            "captures",
            `${current.session}-${crypto.randomUUID()}.png`,
          );
          await sendBrowserCommand(
            home,
            current.session,
            {
              action: "screenshot",
              path,
              format: "png",
              fullPage: operation.fullPage ?? false,
              selector: operation.selector,
              annotate: operation.annotate ?? false,
            },
            signal,
          );
          check();
          content.push(text({ path }), {
            type: "image",
            data: Buffer.from(await readFile(path)).toString("base64"),
            mimeType: "image/png",
          });
        } else if (operation.op !== "viewer") {
          const result = await sendBrowserCommand(
            home,
            current.session,
            browserCommand(operation),
            signal,
          );
          check();
          if (operation.op === "dialog") {
            await reconcileMode(current, browserConnected, signal);
            check();
          }
          content.push(text(result ?? null));
        }
        const viewerUrl = await expose(current, signal);
        check();
        const info = Schema.decodeUnknownSync(Info)(
          await sendBrowserCommand(home, current.session, { action: "session_info" }, signal),
        );
        check();
        content.push(
          text({
            viewerUrl,
            mode: current.mode,
            idleTimeoutMs,
            ...(failedRestore(info.restoreStatus)
              ? {
                  warning:
                    "Saved login failed to restore. Previous state is preserved. Complete login through the viewer, then use checkpoint to recover.",
                }
              : {}),
          }),
        );
        return content;
      } catch (error) {
        if (current.generation !== generation || disposed || archived.has(current.chatId))
          revoke(current);
        throw error;
      } finally {
        if (
          current.generation === generation &&
          (operation.op === "close" || operation.op === "mode")
        )
          current.state = "available";
      }
    });
  };
  const closeChat = (chatId: ChatId) => {
    archived.add(chatId);
    const closing = [...entries.values()].filter((entry) => entry.chatId === chatId);
    for (const entry of closing) {
      entry.generation++;
      entry.state = "closing";
      revoke(entry);
    }
    return closeEntries(closing);
  };
  const closeEntries = async (closing: readonly Entry[]) => {
    const results = await Promise.allSettled(
      closing.map((entry) => enqueue(entry, () => closeEntry(entry))),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Failed to close owned browsers");
  };
  return {
    execute,
    closeChat,
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      for (const entry of entries.values()) {
        entry.generation++;
        entry.state = "closing";
        revoke(entry);
      }
      disposing = closeEntries([...entries.values()]).finally(() => viewer.dispose());
      return disposing;
    },
  };
};
export type BrowserManager = Awaited<ReturnType<typeof makeBrowserManager>>;

type PageOperation = Exclude<BrowserOperation, { op: "mode" | "screenshot" }>;
const browserCommand = (operation: PageOperation): Readonly<Record<string, unknown>> => {
  const { op } = operation;
  switch (op) {
    case "open":
      return operation.url === undefined
        ? { action: "url" }
        : {
            action: "navigate",
            url: /^(?:https?:|about:|data:|file:)/i.test(operation.url)
              ? operation.url
              : `https://${operation.url}`,
          };
    case "snapshot":
      return { ...operation, op: undefined, action: "snapshot" };
    case "back":
    case "forward":
    case "reload":
      return { action: op };
    case "click":
    case "dblclick":
    case "hover":
    case "focus":
    case "check":
    case "uncheck":
    case "scrollintoview":
      return { action: op, selector: operation.selector };
    case "fill":
      return { action: "fill", selector: operation.selector, value: operation.text };
    case "type":
      return { action: "type", selector: operation.selector, text: operation.text };
    case "press":
      return { action: "press", key: operation.key };
    case "select":
      return { action: "select", selector: operation.selector, values: operation.values };
    case "scroll":
      return {
        action: "scroll",
        direction: operation.direction,
        amount: operation.amount ?? 300,
        selector: operation.selector,
      };
    case "drag":
      return { action: "drag", source: operation.source, target: operation.target };
    case "upload":
      return { action: "upload", selector: operation.selector, files: operation.files };
    case "get": {
      const actions = {
        url: "url",
        title: "title",
        html: "innerhtml",
        text: "gettext",
        value: "inputvalue",
        count: "count",
      };
      return { action: actions[operation.what], selector: operation.selector ?? "body" };
    }
    case "wait": {
      const conditions = {
        selector: { action: "wait", selector: operation.value },
        text: { action: "wait", text: operation.value },
        url: { action: "waitforurl", url: operation.value },
        function: { action: "waitforfunction", expression: operation.value },
        load: { action: "waitforloadstate", state: operation.value },
      };
      return { ...conditions[operation.condition], timeout: operation.timeoutMs ?? 25_000 };
    }
    case "eval":
      return { action: "evaluate", script: operation.script };
    case "tabs":
      switch (operation.action) {
        case "list":
          return { action: "tab_list" };
        case "new":
          return { action: "tab_new", url: operation.url };
        case "select":
          return { action: "tab_switch", tabId: operation.tabId };
        case "close":
          return { action: "tab_close", tabId: operation.tabId };
      }
      break;
    case "frame":
      return operation.selector === null
        ? { action: "mainframe" }
        : { action: "frame", selector: operation.selector };
    case "dialog":
      return { action: "dialog", response: operation.response, promptText: operation.promptText };
    case "viewer":
    case "close":
    case "checkpoint":
    case "remember_login":
      throw new Error("Not a page operation");
  }
  const exhaustive: never = operation;
  return exhaustive;
};
