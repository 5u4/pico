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

const richResponder: FakeResponder = (text) => [
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "considering the request" },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "README.md" },
      },
    ],
  } as AgentMessage,
  {
    role: "toolResult",
    toolCallId: "call-1",
    content: [{ type: "text", text: "file contents here" }],
    isError: false,
  } as AgentMessage,
  {
    role: "assistant",
    content: [{ type: "text", text: `echo: ${text}` }],
  } as AgentMessage,
];

const port = Number(Bun.env.PICO_E2E_PORT ?? 4142);
const db = openDb(":memory:");
const sessions = new FakeWebSessions(richResponder);
const engine = new Engine<FakeWebSession>({
  db,
  sessions,
  autoTitle: async () => null,
});
const hub = new WebHub<FakeWebSession>({
  db,
  engine,
  workspaceCwd: "/tmp/pico-e2e",
});
const server = createServer({ port, hub, index, development: true });

process.stdout.write(`pico-e2e listening on ${server.port}\n`);
