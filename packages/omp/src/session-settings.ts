import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
  filterAvailableModelsByEnabledPatterns,
  getModelMatchPreferences,
  parseModelString,
  pickDefaultAvailableModel,
  resolveAllowedModels,
  resolveModelRoleValue,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import * as OmpSettings from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  buildSessionContext,
  getRestorableSessionModels,
} from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { migrateToCurrentVersion } from "@oh-my-pi/pi-coding-agent/session/session-migrations";
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
) {
  return yield* Effect.tryPromise({
    try: async (): Promise<readonly ModelInfo[]> => {
      const settings = await OmpSettings.Settings.loadReadOnly({ cwd });
      return filterAvailableModelsByEnabledPatterns(
        registry.getAvailable(),
        settings.get("enabledModels") ?? [],
        settings,
      ).map(({ provider, id, name }) => ({ provider, id, name }));
    },
    catch: (cause) => agentError("Failed to list available OMP models", cause),
  });
});

/** The runtime reads a cold chat's next model without opening its session or resolving credentials. */
export const loadCurrentModel = Effect.fn("OmpSession.loadCurrentModel")(function* (
  registry: ModelRegistry,
  cwd: AbsolutePath,
  sessionFile: string,
) {
  return yield* Effect.tryPromise({
    try: async (): Promise<ModelInfo | null> => {
      const [settings, entries] = await Promise.all([
        OmpSettings.Settings.loadReadOnly({ cwd }),
        loadEntriesFromFile(sessionFile),
      ]);
      migrateToCurrentVersion(entries);
      const byId = new Map(
        entries
          .filter((entry): entry is SessionEntry => entry.type !== "session")
          .map((entry) => [entry.id, entry]),
      );
      const branch: SessionEntry[] = [];
      const visited = new Set<string>();
      let entry = entries.findLast((entry) => entry.type !== "session");
      while (entry && !visited.has(entry.id)) {
        visited.add(entry.id);
        branch.push(entry);
        entry = entry.parentId ? byId.get(entry.parentId) : undefined;
      }
      branch.reverse();
      const { models } = buildSessionContext(branch, undefined, byId);
      let role: string | undefined;
      let temporary: string | undefined;
      for (const entry of branch) {
        if (entry.type !== "model_change") continue;
        role = entry.role ?? "default";
        if (role === "temporary" && !entry.resolvedModelIsFallback) temporary = entry.model;
      }
      if (role === "temporary" && temporary !== undefined) {
        models.temporary = temporary;
      }
      // Extensions may restore the preferred model when the session opens.
      const [selection] = getRestorableSessionModels(models, role);
      if (selection !== undefined) {
        const ref = parseModelString(selection, {
          allowMaxSuffix: true,
          allowAutoAlias: true,
          isLiteralModelId: (provider, id) => registry.find(provider, id) !== undefined,
        });
        if (!ref) return null;
        const model = registry.find(ref.provider, ref.id);
        return model && registry.hasConfiguredAuth(model)
          ? { provider: model.provider, id: model.id, name: model.name }
          : null;
      }
      const preferences = getModelMatchPreferences(settings);
      const available = await resolveAllowedModels(registry, settings, preferences);
      const model =
        resolveModelRoleValue(settings.getModelRole("default"), available, {
          settings,
          matchPreferences: preferences,
        }).model ??
        pickDefaultAvailableModel(
          available.filter((model) => registry.hasConfiguredAuth(model)),
          (provider) => registry.hasConcreteAuth(provider),
        );
      return model ? { provider: model.provider, id: model.id, name: model.name } : null;
    },
    catch: (cause) => agentError("Failed to read OMP model selection", cause),
  });
});

export const prepareSessionSettings = Effect.fn("OmpSession.prepareSettings")(function* (
  cwd: AbsolutePath,
  platform: WorkspacePlatform,
  externalBrowser: ExternalBrowser,
) {
  const settings = yield* Effect.tryPromise({
    try: () => OmpSettings.Settings.loadIsolated({ cwd }),
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
      if (platform === "discord") {
        settings.override("tui.renderMermaid", false);
      }
      return settings;
    },
    catch: (cause) => agentError("Failed to isolate OMP session settings", cause),
  });
});
