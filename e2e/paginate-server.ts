import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Engine } from "../src/engine/conversations";
import {
  createConversation,
  getOrCreateDefaultWorkspace,
} from "../src/engine/registry";
import { WebHub } from "../src/platforms/web/adapter";
import index from "../src/platforms/web/client/index.html";
import {
  echoResponder,
  type FakeWebSession,
  FakeWebSessions,
} from "../src/platforms/web/fake-session";
import { createServer } from "../src/platforms/web/server";
import { openDb } from "../src/store/db";

const CWD = "/tmp/pico-e2e-paginate";
const COUNT = 120;

const port = Number(Bun.env.PICO_E2E_PAGINATE_PORT ?? 4144);
const db = openDb(":memory:");
const sessions = new FakeWebSessions(echoResponder);
const engine = new Engine<FakeWebSession>({
  db,
  sessions,
  autoTitle: async () => null,
});
const hub = new WebHub<FakeWebSession>({
  db,
  engine,
  workspaceCwd: CWD,
  worktreeCwd: CWD,
});

const workspace = getOrCreateDefaultWorkspace(db, "web", CWD, "seeded");
const conversation = createConversation(db, {
  workspaceId: workspace.id,
  cwd: CWD,
  title: "Seeded history",
});
const opened = await sessions.open(conversation.id);
if (opened.isOk()) {
  opened.value.state.messages = Array.from({ length: COUNT }, (_, i) =>
    i % 2 === 0
      ? ({
          role: "user",
          content: `user line ${i}`,
          timestamp: 0,
        } as AgentMessage)
      : ({
          role: "assistant",
          content: [{ type: "text", text: `assistant line ${i}` }],
          timestamp: 0,
        } as AgentMessage),
  );
}

const server = createServer({ port, hub, index, development: true });

process.stdout.write(`pico-e2e-paginate listening on ${server.port}\n`);
