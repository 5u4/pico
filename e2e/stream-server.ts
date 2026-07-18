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

const streamingResponder: FakeResponder = (text) => [
  {
    role: "assistant",
    content: [{ type: "text", text: `streamed reply to ${text}` }],
  } as AgentMessage,
];

const port = Number(Bun.env.PICO_E2E_STREAM_PORT ?? 4143);
const stepMs = Number(Bun.env.PICO_E2E_STREAM_STEP_MS ?? 120);
const db = openDb(":memory:");
const sessions = new FakeWebSessions(streamingResponder, stepMs);
const engine = new Engine<FakeWebSession>({
  db,
  sessions,
  autoTitle: async () => null,
});
const hub = new WebHub<FakeWebSession>({
  db,
  engine,
  workspaceCwd: "/tmp/pico-e2e-stream",
  worktreeCwd: "/tmp/pico-e2e-stream",
});
const server = createServer({ port, hub, index, development: true });

process.stdout.write(`pico-e2e-stream listening on ${server.port}\n`);
