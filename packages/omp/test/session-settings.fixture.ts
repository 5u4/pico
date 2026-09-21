import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
  getDisabledProviders,
  getEnabledProviders,
  initializeWithSettings,
} from "@oh-my-pi/pi-coding-agent/capability";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { BranchNaming } from "@pico/contract/branch-naming";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import { PicoRoot } from "@pico/contract/config";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { make } from "../src/layer.ts";
import { prepareSessionSettings } from "../src/session-settings.ts";

const root = process.cwd();
assert.equal(homedir(), join(root, "home"));
const agentDir = join(homedir(), ".omp", "agent");
await mkdir(agentDir, { recursive: true });
const globalConfigPath = join(agentDir, "config.yml");
const globalConfig =
  process.argv[2] === "runtime"
    ? "skills:\n  includeSkills: [native-project, claude-user, codex-user]\n"
    : "{}\n";
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

for (const customNames of process.argv[2] === "runtime"
  ? []
  : [["user-skill"], ["user-skill", "pico-schedule", "pico-instructions", "pico-browser"]]) {
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
    const settings = await Effect.runPromise(prepareSessionSettings(cwd, "web", externalBrowser));
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

if (process.argv[2] === "runtime") {
  const sessions = AbsolutePath.make(join(root, "sessions"));
  const foreignExpected = ["claude-user", "codex-user"];
  const nativeExpected = ["native-project"];
  const cases = [
    {
      name: "native",
      config: "disabledProviders: [claude, codex]\nenabledProviders: []\n",
      expected: nativeExpected,
    },
    {
      name: "foreign",
      config: "disabledProviders: [native]\nenabledProviders: [claude, codex]\n",
      expected: foreignExpected,
    },
    {
      name: "legacy",
      config:
        "disabledProviders: [native]\nenabledProviders: []\nskills:\n  enableClaudeUser: true\n  enableCodexUser: true\n",
      expected: foreignExpected,
    },
    {
      name: "disabled",
      config: "skills:\n  enabled: false\n",
      expected: [],
    },
    {
      name: "commands-disabled",
      config: "skills:\n  enableSkillCommands: false\n",
      expected: [],
    },
  ].map((scenario) => ({ ...scenario, cwd: AbsolutePath.make(join(root, scenario.name)) }));
  for (const provider of ["claude", "codex"]) {
    const name = `${provider}-user`;
    const directory = join(homedir(), `.${provider}`, "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Shared ${provider} instructions.\n---\n\nShared instructions.\n`,
    );
  }
  for (const scenario of cases) {
    const directory = join(scenario.cwd, ".omp", "skills", "native-project");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: native-project\ndescription: Native workspace instructions.\n---\n\nWorkspace instructions.\n",
    );
    await writeFile(join(scenario.cwd, ".omp", "config.yml"), scenario.config);
  }

  const unexpected = () => Effect.die("Skill discovery must not open a chat or use schedules");
  const schedules = Schedule.Schedules.of({
    withCurrentTargets: unexpected,
    create: unexpected,
    list: unexpected,
    overview: unexpected,
    get: unexpected,
    update: unexpected,
    remove: unexpected,
    start: unexpected,
  });
  const platform = Layer.mergeAll(
    BunCrypto.layer,
    BunFileSystem.layer,
    BunPath.layer,
    Layer.succeed(ChatSessionContext, { resolve: unexpected }),
    Layer.succeed(BranchNaming, {
      handle: () => {
        throw new Error("Skill discovery must not generate a title");
      },
    }),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* make({
          paths: { root: PicoRoot.make(root), sessionsDir: sessions },
          schedules,
          browser: { externalBrowser: "off", idleTimeoutMs: 10_800_000 },
        });
        const filesBefore = yield* Effect.promise(() => readdir(root, { recursive: true }));
        for (const initializedWorkspace of [undefined, "foreign", "native"]) {
          if (initializedWorkspace !== undefined) {
            const settings = yield* Effect.promise(() =>
              Settings.loadReadOnly({ cwd: join(root, initializedWorkspace) }),
            );
            initializeWithSettings(settings);
          }
          const disabledProviders = getDisabledProviders();
          const enabledProviders = getEnabledProviders();
          const discovered = yield* Effect.all(
            cases.map((scenario) => runtime.discoverSkills(scenario.cwd)),
            { concurrency: "unbounded" },
          );
          assert.deepEqual(
            discovered.map((skills) => skills.map((skill) => skill.name).sort()),
            cases.map((scenario) => scenario.expected),
          );
          assert.deepEqual(getDisabledProviders(), disabledProviders);
          assert.deepEqual(getEnabledProviders(), enabledProviders);
        }
        assert.deepEqual(yield* Effect.promise(() => readdir(sessions)), []);
        assert.deepEqual(
          (yield* Effect.promise(() => readdir(root, { recursive: true }))).sort(),
          filesBefore.sort(),
        );
        for (const scenario of cases) {
          assert.equal(
            yield* Effect.promise(() => readFile(join(scenario.cwd, ".omp", "config.yml"), "utf8")),
            scenario.config,
          );
        }
        assert.equal(yield* Effect.promise(() => readFile(globalConfigPath, "utf8")), globalConfig);
      }),
    ).pipe(Effect.provide(platform)),
  );
}
