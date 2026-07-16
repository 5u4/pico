import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig } from "./config.ts";

describe("parseConfig", () => {
  test("fills defaults for an empty object", () => {
    const result = parseConfig({});
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      workspaceCwd: join(homedir(), ".pico"),
      web: { enabled: false, port: 4141 },
    });
  });

  test("accepts explicit values", () => {
    const result = parseConfig({
      web: { enabled: true, port: 8080 },
      workspaceCwd: "/tmp/projects",
    });
    expect(result._unsafeUnwrap()).toEqual({
      workspaceCwd: "/tmp/projects",
      web: { enabled: true, port: 8080 },
    });
  });

  test("rejects a non-positive port", () => {
    expect(parseConfig({ web: { port: -1 } }).isErr()).toBe(true);
  });
});

describe("loadConfig", () => {
  test("returns defaults when the file is absent", async () => {
    const result = await loadConfig(
      "/tmp/pico-does-not-exist-4141/config.toml",
    );
    expect(result._unsafeUnwrap()).toEqual({
      workspaceCwd: join(homedir(), ".pico"),
      web: { enabled: false, port: 4141 },
    });
  });

  test("parses an existing config file", async () => {
    const path = `/tmp/pico-config-test-${Date.now()}.toml`;
    await Bun.write(path, "[web]\nport = 5000\n");
    try {
      const result = await loadConfig(path);
      expect(result._unsafeUnwrap()).toEqual({
        workspaceCwd: join(homedir(), ".pico"),
        web: { enabled: false, port: 5000 },
      });
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("fills defaults for an empty file", async () => {
    const path = `/tmp/pico-config-empty-${Date.now()}.toml`;
    await Bun.write(path, "");
    try {
      const result = await loadConfig(path);
      expect(result._unsafeUnwrap()).toEqual({
        workspaceCwd: join(homedir(), ".pico"),
        web: { enabled: false, port: 4141 },
      });
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("fills the port default when [web] omits it", async () => {
    const path = `/tmp/pico-config-noport-${Date.now()}.toml`;
    await Bun.write(path, 'workspaceCwd = "/tmp/projects"\n\n[web]\n');
    try {
      const result = await loadConfig(path);
      expect(result._unsafeUnwrap()).toEqual({
        workspaceCwd: "/tmp/projects",
        web: { enabled: false, port: 4141 },
      });
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("errors on malformed toml", async () => {
    const path = `/tmp/pico-config-bad-${Date.now()}.toml`;
    await Bun.write(path, "port = = 5000");
    try {
      expect((await loadConfig(path)).isErr()).toBe(true);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
