import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleAppendPrompt, loadIdentity } from "./identity";

const persona = readFileSync(join(import.meta.dir, "persona.md"), "utf8");

describe("assembleAppendPrompt", () => {
  test("returns persona alone when no identity is present", () => {
    expect(assembleAppendPrompt(undefined)).toBe(persona);
  });

  test("appends identity after persona, persona first", () => {
    const out = assembleAppendPrompt("You are a witty pirate.");
    const personaAt = out.indexOf("# pico");
    const identityAt = out.indexOf("witty pirate");
    expect(personaAt).toBe(0);
    expect(identityAt).toBeGreaterThan(personaAt);
    expect(out).toContain(`${persona}\n\n`);
  });
});

describe("loadIdentity", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pico-identity-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns undefined when the file is absent", () => {
    expect(loadIdentity(join(dir, "identity.md"))).toBeUndefined();
  });

  test("returns the file contents when present", () => {
    const path = join(dir, "identity.md");
    writeFileSync(path, "custom soul");
    expect(loadIdentity(path)).toBe("custom soul");
  });
});
