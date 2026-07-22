import {
  type AuthStorage,
  discoverAuthStorage,
  getAgentDir,
} from "@oh-my-pi/pi-coding-agent";
import { Effect } from "effect";
import { AuthUnavailable } from "./errors.ts";

export class Auth extends Effect.Service<Auth>()("pico/Auth", {
  scoped: Effect.gen(function* () {
    const agentDir = getAgentDir();
    const storage = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => discoverAuthStorage(agentDir),
        catch: (cause) => new AuthUnavailable({ cause }),
      }),
      (handle: AuthStorage) => Effect.sync(() => handle.close()),
    );
    return { storage, agentDir };
  }),
}) {}
