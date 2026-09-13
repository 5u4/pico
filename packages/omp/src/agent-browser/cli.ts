import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Schema from "effect/Schema";

const NativeResponse = Schema.Struct({
  success: Schema.Boolean,
  data: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeResponse = Schema.decodeUnknownSync(NativeResponse);
export const browserKey = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

export const prepareBrowserHome = async (root: string) => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const directory = join(canonicalRoot, "browser");
  const home = join(directory, "home");
  const namespace = browserKey(canonicalRoot).slice(0, 16);
  const socketBase = join(
    process.platform === "win32" ? directory : "/tmp",
    `pico-browser-${process.getuid?.() ?? "user"}`,
  );
  const socketDirectory = join(socketBase, "namespaces", namespace, "run");
  const stateDirectory = join(home, ".agent-browser", "namespaces", namespace, "state", "sessions");
  for (const path of [
    directory,
    home,
    socketBase,
    socketDirectory,
    stateDirectory,
    join(directory, "owners"),
    join(directory, "captures"),
    join(home, ".cache"),
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  const config = join(directory, "agent-browser.json");
  await writeFile(config, JSON.stringify({ plugins: [], noWebmcp: true, hideScrollbars: false }), {
    mode: 0o600,
  });
  await chmod(config, 0o600);
  const environment: Record<string, string> = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "LANG",
    "LC_ALL",
    "TZ",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_RUNTIME_DIR: socketBase,
    AGENT_BROWSER_SOCKET_DIR: socketBase,
    AGENT_BROWSER_NAMESPACE: namespace,
    AGENT_BROWSER_DEFAULT_TIMEOUT: "25000",
    AGENT_BROWSER_NO_XVFB: "1",
    AGENT_BROWSER_NO_WEBMCP: "1",
  });
  return { directory, home, namespace, socketDirectory, stateDirectory, config, environment };
};
export type BrowserHome = Awaited<ReturnType<typeof prepareBrowserHome>>;

export const runBrowserLauncher = async (
  home: BrowserHome,
  args: readonly string[],
  signal?: AbortSignal,
) => {
  if (signal?.aborted) throw new Error("Browser launch cancelled before dispatch");
  const launcher = join(
    dirname(fileURLToPath(import.meta.resolve("agent-browser/package.json"))),
    "bin",
    "agent-browser.js",
  );
  const script =
    "process.umask(0o077);const p=process.argv[1];process.argv=[process.argv[0],p,...process.argv.slice(2)];await import(p);";
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      script,
      pathToFileURL(launcher).href,
      "--config",
      home.config,
      ...args,
    ],
    {
      cwd: home.directory,
      env: home.environment,
      detached: signal !== undefined,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  const readers = [stdoutReader, stderrReader];
  const readOutput = async (reader: typeof stdoutReader) => {
    const decoder = new TextDecoder();
    let output = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return output + decoder.decode();
      output += decoder.decode(value, { stream: true });
    }
  };
  const killGroup = (termination: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, termination);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  let cancellation: Promise<void> | undefined;
  let cleanupError: unknown;
  const cancel = () => {
    if (cancellation) return;
    cancellation = (async () => {
      const pipes = Promise.allSettled(readers.map((reader) => reader.cancel()));
      try {
        if (process.platform === "win32") {
          const killer = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            timeout: 1_000,
            killSignal: "SIGKILL",
          });
          if ((await killer.exited) !== 0 && child.exitCode === null)
            throw new Error("Failed to terminate browser launcher tree");
        } else {
          // The npm wrapper and native client share this group; the daemon calls setsid().
          killGroup("SIGTERM");
          await Bun.sleep(250);
          killGroup("SIGKILL");
        }
      } finally {
        child.kill("SIGKILL");
        await child.exited;
        await pipes;
      }
    })().catch((error: unknown) => {
      cleanupError = error;
    });
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const [exit, stdout, stderr] = await Promise.allSettled([
      child.exited,
      readOutput(stdoutReader),
      readOutput(stderrReader),
    ]);
    signal?.removeEventListener("abort", cancel);
    await cancellation;
    if (cancellation) {
      const error = new Error(
        "Browser launch cancelled; the native startup outcome is uncertain. The browser may still start or change mode; inspect the session before retrying.",
      );
      if (cleanupError !== undefined)
        throw new AggregateError([error, cleanupError], error.message);
      throw error;
    }
    if (exit.status === "rejected") throw exit.reason;
    if (stdout.status === "rejected") throw stdout.reason;
    if (stderr.status === "rejected") throw stderr.reason;
    if (exit.value !== 0)
      throw new Error(
        `Browser launcher failed. Run pico browser install for this root. ${stderr.value.trim() || stdout.value.trim()}`,
      );
    return stdout.value;
  } finally {
    signal?.removeEventListener("abort", cancel);
    for (const reader of readers) reader.releaseLock();
  }
};

export const launchBrowser = async (
  home: BrowserHome,
  session: string,
  headed: boolean,
  idleTimeoutMs: number,
  signal?: AbortSignal,
) => {
  const output = await runBrowserLauncher(
    home,
    [
      "--session",
      session,
      "--restore",
      session,
      "--restore-save",
      "auto",
      "--headed",
      String(headed),
      "--idle-timeout",
      String(idleTimeoutMs),
      "--json",
      "get",
      "url",
    ],
    signal,
  );
  const response = decodeResponse(JSON.parse(output));
  if (!response.success) throw new Error(response.error ?? "Browser launch failed");
};

export class BrowserUnavailable extends Error {}

// The pinned native protocol is newline-delimited JSON. Unlike CLI flags it treats every page string as data.
export const sendBrowserCommand = (
  home: BrowserHome,
  session: string,
  command: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Browser operation cancelled before dispatch"));
      return;
    }
    const socket = createConnection({ path: join(home.socketDirectory, `${session}.sock`) });
    let received = "";
    let settled = false;
    let connected = false;
    const finish = (error: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const cancel = () =>
      finish(
        new Error(
          connected
            ? "Browser operation cancelled; the command outcome is uncertain. The native command may still run; inspect the page before retrying."
            : "Browser operation cancelled before dispatch",
        ),
      );
    const deadline = setTimeout(
      () =>
        finish(
          new Error(
            "Browser command timed out; its outcome is uncertain. Inspect the page before retrying.",
          ),
        ),
      120_000,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      if (settled) return;
      connected = true;
      socket.write(`${JSON.stringify({ ...command, id: crypto.randomUUID() })}\n`);
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      received += chunk;
      if (received.length > 32 * 1024 * 1024)
        return finish(new Error("Browser response exceeded 32 MiB"));
      const end = received.indexOf("\n");
      if (end === -1) return;
      try {
        const response = decodeResponse(JSON.parse(received.slice(0, end)));
        if (!response.success) finish(new Error(response.error ?? "Browser command failed"));
        else finish(undefined, response.data);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => {
      const unavailable =
        !connected && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED");
      finish(unavailable ? new BrowserUnavailable("Browser is not running") : error);
    });
    socket.on("close", () => {
      socket.removeAllListeners();
      finish(
        new Error(
          "Browser disconnected; the command outcome is uncertain. Inspect the page before retrying.",
        ),
      );
    });
  });
