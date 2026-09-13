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
const bundledInstructionsPath = Bun.fileURLToPath(
  new URL("../src/skills/pico-instructions/SKILL.md", import.meta.url),
);
const bundledBrowserPath = Bun.fileURLToPath(
  new URL("../src/agent-browser/skills/pico-browser/SKILL.md", import.meta.url),
);

for (const customNames of [
  ["user-skill"],
  ["user-skill", "pico-schedule", "pico-instructions", "pico-browser"],
]) {
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
  const instructionsPath = customNames.includes("pico-instructions")
    ? join(customDir, "pico-instructions", "SKILL.md")
    : bundledInstructionsPath;
  const browserPath = customNames.includes("pico-browser")
    ? join(customDir, "pico-browser", "SKILL.md")
    : bundledBrowserPath;
  const alwaysExpected = [
    { name: "pico-instructions", filePath: await realpath(instructionsPath) },
    { name: "pico-schedule", filePath: await realpath(schedulePath) },
    { name: "user-skill", filePath: await realpath(join(customDir, "user-skill", "SKILL.md")) },
  ];

  for (const externalBrowser of ["off", "agent-browser", "agent-browser", "off"] as const) {
    const settings = await Effect.runPromise(prepareSessionSettings(cwd, null, externalBrowser));
    const { skills } = await loadSkills({ cwd, ...settings.getGroup("skills") });
    const discovered = await Promise.all(
      skills.map(async (skill) => ({ name: skill.name, filePath: await realpath(skill.filePath) })),
    );
    for (const skill of alwaysExpected) {
      assert.deepEqual(
        discovered.filter(({ name }) => name === skill.name),
        [skill],
      );
    }
    assert.deepEqual(
      discovered.filter(({ name }) => name === "pico-browser"),
      externalBrowser === "agent-browser" || customNames.includes("pico-browser")
        ? [{ name: "pico-browser", filePath: await realpath(browserPath) }]
        : [],
    );

    settings.override("skills.ignoredSkills", ["pico-browser"]);
    const filtered = await loadSkills({ cwd, ...settings.getGroup("skills") });
    assert.equal(
      filtered.skills.some(({ name }) => name === "pico-browser"),
      false,
    );
    assert.equal(
      filtered.skills.some(({ name }) => name === "pico-schedule"),
      true,
    );
    settings.override("skills.enabled", false);
    assert.deepEqual((await loadSkills({ cwd, ...settings.getGroup("skills") })).skills, []);

    await settings.flush();
    assert.equal(await readFile(configPath, "utf8"), config);
    assert.equal(await readFile(globalConfigPath, "utf8"), globalConfig);
  }
}
