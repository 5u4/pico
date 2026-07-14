import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { loadConfig, parseConfig } from "./config.ts";

describe("parseConfig", () => {
  test("fills defaults for an empty object", () => {
    const result = parseConfig({});
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      port: 4141,
      projectsRoot: homedir(),
    });
  });

  test("accepts explicit values", () => {
    const result = parseConfig({ port: 8080, projectsRoot: "/tmp/projects" });
    expect(result._unsafeUnwrap()).toEqual({
      port: 8080,
      projectsRoot: "/tmp/projects",
    });
  });

  test("rejects a non-positive port", () => {
    expect(parseConfig({ port: -1 }).isErr()).toBe(true);
  });
});

describe("loadConfig", () => {
  test("returns defaults when the file is absent", async () => {
    const result = await loadConfig(
      "/tmp/pico-does-not-exist-4141/config.json",
    );
    expect(result._unsafeUnwrap()).toEqual({
      port: 4141,
      projectsRoot: homedir(),
    });
  });

  test("parses an existing config file", async () => {
    const path = `/tmp/pico-config-test-${Date.now()}.json`;
    await Bun.write(path, JSON.stringify({ port: 5000 }));
    const result = await loadConfig(path);
    expect(result._unsafeUnwrap()).toEqual({
      port: 5000,
      projectsRoot: homedir(),
    });
  });

  test("errors on malformed json", async () => {
    const path = `/tmp/pico-config-bad-${Date.now()}.json`;
    await Bun.write(path, "{ not json");
    expect((await loadConfig(path)).isErr()).toBe(true);
  });
});
