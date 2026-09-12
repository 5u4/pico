import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { AbsolutePath } from "@pico/contract/path";
import * as Effect from "effect/Effect";
import { prepareSessionSettings } from "../src/session-settings.ts";

const root = process.cwd();
assert.equal(homedir(), join(root, "home"));
const agentDir = join(homedir(), ".omp", "agent");
await mkdir(agentDir, { recursive: true });
const globalConfigPath = join(agentDir, "config.yml");
const globalConfig = "{}\n";
await writeFile(globalConfigPath, globalConfig);

const bundledSchedulePath = Bun.fileURLToPath(
  new URL("../src/skills/pico-schedule/SKILL.md", import.meta.url),
);
const bundledIdentityPath = Bun.fileURLToPath(
  new URL("../src/skills/pico-identity/SKILL.md", import.meta.url),
);

for (const customNames of [["user-skill"], ["user-skill", "pico-schedule", "pico-identity"]]) {
  const cwd = AbsolutePath.make(join(root, `project-${customNames.length}`));
  const customDir = join(cwd, "custom-skills");
  await mkdir(join(cwd, ".omp"), { recursive: true });
  for (const name of customNames) {
    await mkdir(join(customDir, name), { recursive: true });
    await writeFile(
      join(customDir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: User instructions for ${name}.\n---\n\nUser-owned ${name}.\n`,
    );
  }

  const configPath = join(cwd, ".omp", "config.yml");
  const config = `skills:\n  customDirectories:\n    - ${JSON.stringify(customDir)}\n`;
  await writeFile(configPath, config);
  const schedulePath = customNames.includes("pico-schedule")
    ? join(customDir, "pico-schedule", "SKILL.md")
    : bundledSchedulePath;
  const identityPath = customNames.includes("pico-identity")
    ? join(customDir, "pico-identity", "SKILL.md")
    : bundledIdentityPath;
  const expected = [
    { name: "pico-identity", filePath: await realpath(identityPath) },
    { name: "pico-schedule", filePath: await realpath(schedulePath) },
    { name: "user-skill", filePath: await realpath(join(customDir, "user-skill", "SKILL.md")) },
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const settings = await Effect.runPromise(prepareSessionSettings(cwd, null));
    const { skills } = await loadSkills({ cwd, ...settings.getGroup("skills") });
    const discovered = await Promise.all(
      skills.map(async (skill) => ({ name: skill.name, filePath: await realpath(skill.filePath) })),
    );
    for (const skill of expected) {
      assert.deepEqual(
        discovered.filter(({ name }) => name === skill.name),
        [skill],
      );
    }
    await settings.flush();
    assert.equal(await readFile(configPath, "utf8"), config);
    assert.equal(await readFile(globalConfigPath, "utf8"), globalConfig);
  }
}
