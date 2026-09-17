import { RegistryContext, scheduleTask } from "@effect/atom-react/RegistryContext";
import * as FrontendState from "@pico/frontend-state/client";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { useContext, useEffect, useState } from "react";
import { usePage } from "./routes.tsx";
import { WorkspaceChat } from "./workspace-chat.tsx";

interface Session {
  readonly state: ReturnType<typeof FrontendState.make>;
  readonly registry: AtomRegistry.AtomRegistry;
}

export function App() {
  const page = usePage();
  const bootRegistry = useContext(RegistryContext);
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    const url = new URL("/rpc", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const registry = AtomRegistry.make({ scheduleTask });
    const state = FrontendState.make({ url: url.href });
    const ensure = () => registry.set(state.ensure, undefined);
    const visible = () => {
      if (document.visibilityState === "visible") ensure();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) ensure();
    };
    window.addEventListener("focus", ensure);
    window.addEventListener("online", ensure);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", restored);
    setSession({ registry, state });
    ensure();
    return () => {
      window.removeEventListener("focus", ensure);
      window.removeEventListener("online", ensure);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", restored);
      registry.dispose();
    };
  }, []);
  return (
    <RegistryContext.Provider value={session?.registry ?? bootRegistry}>
      <WorkspaceChat page={page} state={session?.state ?? null} />
    </RegistryContext.Provider>
  );
}
