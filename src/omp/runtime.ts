import type { Model } from "@oh-my-pi/pi-catalog";
import {
  discoverAuthStorage,
  getAgentDir,
  ModelRegistry,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import {
  pickDefaultAvailableModel,
  resolveRoleSelection,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { err, ok, type Result, ResultAsync } from "neverthrow";

export interface OmpRuntime {
  agentDir: string;
  settings: Settings;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  defaultModel: Model;
}

export interface ProvisionOptions {
  cwd: string;
  agentDir?: string;
}

export async function provisionRuntime(
  options: ProvisionOptions,
): Promise<Result<OmpRuntime, string>> {
  const agentDir = options.agentDir ?? getAgentDir();

  const built = await ResultAsync.fromPromise(
    build(options.cwd, agentDir),
    (e) => (e instanceof Error ? e.message : String(e)),
  );
  if (built.isErr()) return err(built.error);

  const { settings, authStorage, modelRegistry, refreshError } = built.value;
  const available = modelRegistry.getAvailable();
  const defaultModel =
    resolveRoleSelection(["default"], settings, available)?.model ??
    pickDefaultAvailableModel(available) ??
    available[0];
  if (!defaultModel) {
    const base = "no available model resolved from registry";
    return err(
      refreshError ? `${base} (model refresh failed: ${refreshError})` : base,
    );
  }

  return ok({ agentDir, settings, authStorage, modelRegistry, defaultModel });
}

async function build(
  cwd: string,
  agentDir: string,
): Promise<
  Omit<OmpRuntime, "agentDir" | "defaultModel"> & { refreshError?: string }
> {
  const settings = await Settings.init({ cwd, agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  const modelRegistry = new ModelRegistry(authStorage);
  const refreshError = await modelRegistry
    .refresh("online-if-uncached")
    .then(() => undefined)
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  return { settings, authStorage, modelRegistry, refreshError };
}
