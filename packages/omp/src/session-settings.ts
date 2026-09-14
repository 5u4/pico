import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { filterAvailableModelsByEnabledPatterns } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import * as OmpSettings from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ModelInfo } from "@pico/contract/agent-runtime";
import type { ExternalBrowser } from "@pico/contract/config";
import type { AbsolutePath } from "@pico/contract/path";
import type { WorkspacePlatform } from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import { agentError } from "./agent-error.ts";

const bundledSkillsDirectory = Bun.fileURLToPath(new URL("./skills", import.meta.url));
const agentBrowserSkillsDirectory = Bun.fileURLToPath(
  new URL("./agent-browser/skills", import.meta.url),
);

export const loadAvailableModels = Effect.fn("OmpSession.loadAvailableModels")(function* (
  registry: ModelRegistry,
  cwd: AbsolutePath,
  agentDir?: AbsolutePath,
) {
  return yield* Effect.tryPromise({
    try: async (): Promise<readonly ModelInfo[]> => {
      const settings = await OmpSettings.Settings.loadReadOnly({
        cwd,
        ...(agentDir === undefined ? {} : { agentDir }),
      });
      return filterAvailableModelsByEnabledPatterns(
        registry.getAvailable(),
        settings.get("enabledModels") ?? [],
        settings,
      ).map(({ provider, id, name }) => ({ provider, id, name }));
    },
    catch: (cause) => agentError("Failed to list available OMP models", cause),
  });
});

export const prepareSessionSettings = Effect.fn("OmpSession.prepareSettings")(function* (
  cwd: AbsolutePath,
  platform: WorkspacePlatform | null,
  externalBrowser: ExternalBrowser,
  botAgentDir?: AbsolutePath,
) {
  const settings = yield* Effect.tryPromise({
    try: () =>
      OmpSettings.Settings.loadIsolated({
        cwd,
        ...(botAgentDir === undefined ? {} : { agentDir: botAgentDir }),
      }),
    catch: (cause) => agentError("Failed to load OMP settings", cause),
  });
  return yield* Effect.try({
    try: () => {
      settings.override("async.enabled", false);
      settings.override("title.refreshOnReplan", false);
      const skillDirectories = [
        ...settings.get("skills.customDirectories"),
        bundledSkillsDirectory,
      ];
      switch (externalBrowser) {
        case "off":
          break;
        case "agent-browser":
          settings.override("browser.enabled", false);
          skillDirectories.push(agentBrowserSkillsDirectory);
          break;
        default: {
          const exhaustive: never = externalBrowser;
          return exhaustive;
        }
      }
      settings.override("skills.customDirectories", skillDirectories);
      settings.override("secrets.enabled", true);
      if (botAgentDir !== undefined) {
        settings.override("memory.backend", "local");
        settings.override("compaction.enabled", true);
      }
      if (platform === "discord") {
        settings.override("tui.renderMermaid", false);
      }
      return settings;
    },
    catch: (cause) => agentError("Failed to isolate OMP session settings", cause),
  });
});
