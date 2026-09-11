import * as OmpSettings from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import type { WorkspacePlatform } from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";

const agentError = (message: string, cause: unknown) =>
  new AgentError({
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

export const prepareSessionSettings = Effect.fn("OmpSession.prepareSettings")(function* (
  cwd: AbsolutePath,
  platform: WorkspacePlatform | null,
) {
  const settings = yield* Effect.tryPromise({
    try: () => OmpSettings.Settings.loadIsolated({ cwd }),
    catch: (cause) => agentError("Failed to load OMP settings", cause),
  });
  return yield* Effect.try({
    try: () => {
      settings.override("async.enabled", false);
      settings.override("title.refreshOnReplan", false);
      switch (platform) {
        case null:
          break;
        case "discord":
          settings.override("tui.renderMermaid", false);
          break;
        default: {
          const exhaustive: never = platform;
          return exhaustive;
        }
      }
      return settings;
    },
    catch: (cause) => agentError("Failed to isolate OMP session settings", cause),
  });
});
