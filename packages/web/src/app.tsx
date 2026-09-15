import { RegistryContext, scheduleTask } from "@effect/atom-react/RegistryContext";
import * as FrontendState from "@pico/frontend-state/client";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { useContext, useEffect, useState } from "react";
import { WorkspaceChat } from "./workspace-chat.tsx";

interface Session {
  readonly state: ReturnType<typeof FrontendState.make>;
  readonly registry: AtomRegistry.AtomRegistry;
}

export function App() {
  const bootRegistry = useContext(RegistryContext);
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    const url = new URL("/rpc", window.location.href);
    url.protocol = "ws:";
    const registry = AtomRegistry.make({ scheduleTask });
    setSession({ registry, state: FrontendState.make({ url: url.href }) });
    return () => registry.dispose();
  }, []);
  return (
    <RegistryContext.Provider value={session?.registry ?? bootRegistry}>
      <WorkspaceChat state={session?.state ?? null} />
    </RegistryContext.Provider>
  );
}
