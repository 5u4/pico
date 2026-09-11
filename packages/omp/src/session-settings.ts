import * as OmpSettings from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import type { WorkspacePlatform } from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";

type SessionPlatform = WorkspacePlatform | "web";

interface PlatformSessionPolicy {
  readonly appendSystemPrompt: string;
  readonly mermaid: "disabled" | "inherit";
}

const platformSessionPolicies = {
  discord: {
    appendSystemPrompt:
      "You are pico, a personal agent assistant. You are chatting with the user through Discord.",
    mermaid: "disabled",
  },
  web: {
    appendSystemPrompt:
      "You are pico, a personal agent assistant. You are chatting with the user through Pico Web.",
    mermaid: "inherit",
  },
} satisfies Record<SessionPlatform, PlatformSessionPolicy>;

const agentError = (message: string, cause: unknown) =>
  new AgentError({
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

export const prepareSessionOptions = Effect.fn("OmpSession.prepareOptions")(function* (
  cwd: AbsolutePath,
  platform: WorkspacePlatform | null,
) {
  const policy = platformSessionPolicies[platform ?? "web"];
  const settings = yield* Effect.tryPromise({
    try: () => OmpSettings.Settings.loadIsolated({ cwd }),
    catch: (cause) => agentError("Failed to load OMP settings", cause),
  });
  return yield* Effect.try({
    try: () => {
      settings.override("async.enabled", false);
      settings.override("title.refreshOnReplan", false);
      settings.override("secrets.enabled", true);
      if (policy.mermaid === "disabled") {
        settings.override("tui.renderMermaid", false);
      }
      return { settings, appendSystemPrompt: policy.appendSystemPrompt };
    },
    catch: (cause) => agentError("Failed to isolate OMP session settings", cause),
  });
});
