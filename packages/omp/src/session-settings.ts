import * as OmpSettings from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExternalBrowser } from "@pico/contract/config";
import type { AbsolutePath } from "@pico/contract/path";
import type { WorkspacePlatform } from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import { agentError } from "./agent-error.ts";

const bundledSkillsDirectory = Bun.fileURLToPath(new URL("./skills", import.meta.url));
const agentBrowserSkillsDirectory = Bun.fileURLToPath(
  new URL("./agent-browser/skills", import.meta.url),
);

export const prepareSessionSettings = Effect.fn("OmpSession.prepareSettings")(function* (
  cwd: AbsolutePath,
  platform: WorkspacePlatform | null,
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
