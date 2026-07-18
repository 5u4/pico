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
import { log } from "../util/log";
import { errMessage } from "../util/result";

const logger = log(["runtime"]);

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
    errMessage,
  );
  if (built.isErr()) return err(built.error);

  const { settings, authStorage, modelRegistry, refreshError } = built.value;
  if (refreshError) {
    logger.warning("model registry refresh failed, using cached: {error}", {
      error: refreshError,
    });
  }
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

  logger.info("omp runtime ready (default model {model}, {count} available)", {
    model: defaultModel.id,
    count: available.length,
  });
  return ok({ agentDir, settings, authStorage, modelRegistry, defaultModel });
}

async function build(
  cwd: string,
  agentDir: string,
): Promise<
  Omit<OmpRuntime, "agentDir" | "defaultModel"> & { refreshError?: string }
> {
  const settings = await Settings.init({ cwd, agentDir });
  settings.override("secrets.enabled", true);
  const authStorage = await discoverAuthStorage(agentDir);
  const modelRegistry = new ModelRegistry(authStorage);
  const refreshError = await modelRegistry
    .refresh("online-if-uncached")
    .then(() => undefined)
    .catch(errMessage);
  return { settings, authStorage, modelRegistry, refreshError };
}
