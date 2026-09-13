import type { PicoRoot } from "@pico/contract/config";
import * as Effect from "effect/Effect";
import { prepareBrowserHome, runBrowserLauncher } from "./cli.ts";

// The CLI calls this when the operator installs Chrome for a Pico root.
export const install = Effect.fn("AgentBrowser.install")(function* (root: PicoRoot) {
  yield* Effect.tryPromise({
    try: async () => {
      const home = await prepareBrowserHome(root);
      await runBrowserLauncher(home, ["install"]);
    },
    catch: (cause) =>
      new Error(cause instanceof Error ? cause.message : "Browser installation failed"),
  });
  yield* Effect.logInfo("Installed the browser for this Pico root");
});
