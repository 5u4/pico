import { AgentError } from "@pico/contract/errors";
import * as PlatformError from "effect/PlatformError";

export const agentError = (message: string, cause: unknown): AgentError => {
  if (cause instanceof AgentError) return cause;
  if (cause instanceof PlatformError.PlatformError) {
    return new AgentError({ message: `${message}: ${cause.reason._tag}` });
  }
  if (cause instanceof Error) {
    if (cause.message.startsWith("No API key found")) {
      return new AgentError({ message: `${message}: model credentials are unavailable` });
    }
    if (cause.message.startsWith("No model selected")) {
      return new AgentError({ message: `${message}: no model is selected` });
    }
    if ("code" in cause) {
      switch (cause.code) {
        case "EACCES":
        case "EPERM":
        case "ENOENT":
        case "ENOSPC":
        case "EEXIST":
        case "ETIMEDOUT":
        case "ECONNREFUSED":
        case "ECONNRESET":
          return new AgentError({ message: `${message}: ${cause.code}` });
      }
    }
    if (
      "status" in cause &&
      typeof cause.status === "number" &&
      Number.isInteger(cause.status) &&
      cause.status >= 400 &&
      cause.status <= 599
    ) {
      return new AgentError({ message: `${message}: HTTP ${cause.status}` });
    }
  }
  return new AgentError({ message });
};
