import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Engine } from "../src/engine/conversations";
import { WebHub } from "../src/platforms/web/adapter";
import index from "../src/platforms/web/client/index.html";
import {
  type FakeResponder,
  type FakeWebSession,
  FakeWebSessions,
} from "../src/platforms/web/fake-session";
import { createServer } from "../src/platforms/web/server";
import { openDb } from "../src/store/db";

const LINES = 40;

const tallResponder: FakeResponder = () => [
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: Array.from({ length: LINES }, (_, i) => `sticky line ${i}`).join(
          "\n\n",
        ),
      },
    ],
  } as AgentMessage,
];

const port = Number(Bun.env.PICO_E2E_STICKY_PORT ?? 4145);
const stepMs = Number(Bun.env.PICO_E2E_STICKY_STEP_MS ?? 40);
const db = openDb(":memory:");
const sessions = new FakeWebSessions(tallResponder, stepMs);
const engine = new Engine<FakeWebSession>({
  db,
  sessions,
  autoTitle: async () => null,
});
const hub = new WebHub<FakeWebSession>({
  db,
  engine,
  workspaceCwd: "/tmp/pico-e2e-sticky",
  worktreeCwd: "/tmp/pico-e2e-sticky",
});
const server = createServer({ port, hub, index, development: true });

process.stdout.write(`pico-e2e-sticky listening on ${server.port}\n`);
