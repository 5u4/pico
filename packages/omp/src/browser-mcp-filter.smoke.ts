import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import * as AgentBrowserCli from "./agent-browser/cli.ts";

const fixturePath = Bun.fileURLToPath(
  new URL("../test/fixtures/browser-mcp-filter.ts", import.meta.url),
);

for (const [externalBrowser, nativeBrowser] of [
  ["off", true],
  ["off", false],
  ["agent-browser", true],
] as const) {
  it(`honors ${externalBrowser} with native browser ${nativeBrowser} across MCP startup and reconciliation`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pico-browser-mcp-")));
    try {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "--no-env-file",
          fixturePath,
          externalBrowser,
          String(nativeBrowser),
        ],
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          PI_CODING_AGENT_DIR: join(root, ".omp", "agent"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_CACHE_HOME: join(root, "cache"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
        killSignal: "SIGKILL",
      });
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    } finally {
      await rm(
        join(
          process.platform === "win32" ? join(root, "browser") : "/tmp",
          `pico-browser-${process.getuid?.() ?? "user"}`,
          "namespaces",
          AgentBrowserCli.browserKey(root).slice(0, 16),
        ),
        { recursive: true, force: true },
      );
      await rm(root, { recursive: true, force: true });
    }
  });
}
