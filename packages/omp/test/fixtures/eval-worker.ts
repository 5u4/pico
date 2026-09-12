import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  SessionSnapshot,
  Transport,
  WorkerInbound,
  WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const scenario = process.argv[2];
const originalCwd = process.cwd();
const root = await realpath(await mkdtemp(join(tmpdir(), "pico-eval-worker-")));
process.env.HOME = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "home", ".omp", "agent");
delete process.env.PI_CONFIG_FILES;
await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
process.chdir(root);

const messages: WorkerOutbound[] = [];
let changed = Promise.withResolvers<void>();
let receive: ((message: WorkerInbound) => void) | undefined;
const closed = Promise.withResolvers<void>();
let transportClosed = false;
const snapshot: SessionSnapshot = { cwd: root, sessionId: "worker-drain-regression" };
const transport: Transport = {
  send(message) {
    assert.equal(transportClosed, false, `Message after transport close: ${message.type}`);
    messages.push(message);
    changed.resolve();
    changed = Promise.withResolvers<void>();
  },
  onMessage(handler) {
    receive = handler;
    return () => {
      receive = undefined;
    };
  },
  close() {
    transportClosed = true;
    closed.resolve();
  },
};

async function deadline<T>(label: string, operation: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(`Timed out waiting for ${label}: ${JSON.stringify(messages)}`));
  }, 3_000);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function send(message: WorkerInbound): void {
  assert.ok(receive, `Worker is not accepting ${message.type}`);
  receive(message);
}

async function waitFor(label: string, predicate: (message: WorkerOutbound) => boolean) {
  return deadline(
    label,
    (async () => {
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        await changed.promise;
      }
    })(),
  );
}

function run(runId: string, code: string): void {
  send({ type: "run", runId, code, filename: join(root, `${runId}.ts`), snapshot });
}

async function result(runId: string) {
  const message = await waitFor(
    `${runId} result`,
    (entry) => entry.type === "result" && entry.runId === runId,
  );
  assert.ok(message.type === "result");
  return message;
}

async function toolCall(runId: string, name: string) {
  const message = await waitFor(
    `${runId} ${name} bridge request`,
    (entry) => entry.type === "tool-call" && entry.runId === runId && entry.name === name,
  );
  assert.ok(message.type === "tool-call");
  return message;
}

async function bodyReturned(runId: string): Promise<void> {
  await waitFor(
    `${runId} body marker`,
    (entry) => entry.type === "text" && entry.runId === runId && entry.chunk === "body-returned\n",
  );
  await Bun.sleep(0);
  await Bun.sleep(0);
}

function jsonOutputs(runId: string): unknown[] {
  return messages.flatMap((entry) =>
    entry.type === "display" && entry.runId === runId && entry.output.type === "json"
      ? [entry.output.data]
      : [],
  );
}

function assertStillRunning(runId: string): void {
  assert.equal(
    messages.some((entry) => entry.type === "result" && entry.runId === runId),
    false,
    `${runId} completed before its bridge reply`,
  );
}

async function lateSuccess(): Promise<void> {
  run(
    "origin",
    'comments = agent("late success", { agent: "task" }); print("body-returned"); undefined;',
  );
  const call = await toolCall("origin", "__agent__");
  await bodyReturned("origin");
  send({
    type: "tool-reply",
    id: call.id,
    reply: { ok: true, value: { id: "LateAgent", agent: "task" } },
  });
  assert.equal((await result("origin")).ok, true);
  run(
    "consumer",
    "const handle = await comments; display({ id: handle.id, agent: handle.agent, handle: handle.handle });",
  );
  assert.equal((await result("consumer")).ok, true);
  assert.deepEqual(jsonOutputs("consumer"), [
    { id: "LateAgent", agent: "task", handle: "agent://LateAgent" },
  ]);
}

async function lateError(handled: boolean): Promise<void> {
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { runEvalAgent } = await import("@oh-my-pi/pi-coding-agent/eval/agent-bridge");
  const { ToolError } = await import("@oh-my-pi/pi-coding-agent/tools/tool-errors");
  const session: ToolSession = {
    cwd: root,
    hasUI: false,
    getSessionFile: () => null,
    getSessionSpawns: () => null,
    settings: Settings.isolated({ "async.enabled": false }),
  };
  run(
    "origin",
    `comments = agent("late error", { agent: "task" });
    ${handled ? "comments.catch(error => { display({ caught: error.message }); });" : ""}
    print("body-returned"); undefined;`,
  );
  const call = await toolCall("origin", "__agent__");
  await bodyReturned("origin");
  const expected = await runEvalAgent(call.args, { session }).then(
    () => assert.fail("agent() unexpectedly acquired an async manager"),
    (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.match(error.message, /async job manager; unavailable here/);
      return error;
    },
  );
  send({
    type: "tool-reply",
    id: call.id,
    reply: {
      ok: false,
      error: { name: expected.name, message: expected.message, isToolError: true },
    },
  });
  const origin = await result("origin");
  if (handled) {
    assert.equal(origin.ok, true);
    assert.deepEqual(jsonOutputs("origin"), [{ caught: expected.message }]);
  } else {
    assert.ok(!origin.ok, "An unhandled late manager failure must fail the originating cell");
    assert.ok(origin.error.message.includes(expected.message));
    assert.equal(origin.error.isToolError, true);
  }
  run("consumer", "await comments;");
  const consumer = await result("consumer");
  assert.ok(!consumer.ok, "The original handle must remain rejected for later cells");
  assert.equal(consumer.error.message, expected.message);
  assert.equal(consumer.error.isToolError, true);
}

async function chainedRequests(exported: boolean): Promise<void> {
  const body = `chain = agent("chain", { agent: "task" }).then(handle => handle.status()).then(status => {
    ${exported ? "display({ progress: status });" : ""}
    return status;
  });
  print("body-returned");`;
  if (exported) {
    run("define", `tool(function startChain() { ${body} return "started"; }); undefined;`);
    assert.equal((await result("define")).ok, true);
    send({ type: "tool", runId: "origin", op: "call", name: "startChain", args: {} });
  } else {
    run("origin", `${body} undefined;`);
  }
  const first = await toolCall("origin", "__agent__");
  await bodyReturned("origin");
  assertStillRunning("origin");
  send({
    type: "tool-reply",
    id: first.id,
    reply: { ok: true, value: { id: "ChainAgent", agent: "task" } },
  });
  const second = await toolCall("origin", "__status__");
  assert.deepEqual(second.args, { item: { kind: "agent", id: "ChainAgent" } });
  await Bun.sleep(0);
  await Bun.sleep(0);
  assertStillRunning("origin");
  send({ type: "tool-reply", id: second.id, reply: { ok: true, value: { status: "completed" } } });
  assert.equal((await result("origin")).ok, true);
  if (exported) {
    assert.deepEqual(jsonOutputs("origin"), [
      { progress: "completed" },
      { ok: true, value: "started" },
    ]);
  }
  run("consumer", "display({ status: await chain });");
  assert.equal((await result("consumer")).ok, true);
  assert.deepEqual(jsonOutputs("consumer"), [{ status: "completed" }]);
}

async function raceLocalLoser(): Promise<void> {
  run(
    "origin",
    `const loser = new Promise(() => {});
    const winner = await Promise.race([agent("race", { agent: "task" }), loser]);
    display({ winner: winner.id });`,
  );
  const call = await toolCall("origin", "__agent__");
  send({
    type: "tool-reply",
    id: call.id,
    reply: { ok: true, value: { id: "RaceWinner", agent: "task" } },
  });
  assert.equal((await result("origin")).ok, true);
  assert.deepEqual(jsonOutputs("origin"), [{ winner: "RaceWinner" }]);
}

async function staleContinuation(): Promise<void> {
  const release = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<unknown>();
  Reflect.set(globalThis, "__workerDrainProbe__", {
    release: release.promise,
    observed: observed.resolve,
  });
  run(
    "origin",
    `const probe = globalThis.__workerDrainProbe__;
    const bridge = globalThis.__omp_call_tool__;
    void probe.release.then(async () => {
      try { probe.observed(await bridge("after_finish", {})); }
      catch (error) { probe.observed(error); }
    });
    undefined;`,
  );
  assert.equal((await result("origin")).ok, true);
  release.resolve();
  const error = await deadline("stale continuation rejection", observed.promise);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ToolError");
  assert.equal(
    messages.some((entry) => entry.type === "tool-call"),
    false,
  );
}

async function shutdown(dispose: () => void): Promise<void> {
  const pending = Promise.withResolvers<unknown>();
  const stale = Promise.withResolvers<unknown>();
  Reflect.set(globalThis, "__workerDrainProbe__", {
    pending: pending.resolve,
    stale: stale.resolve,
  });
  run(
    "origin",
    `const probe = globalThis.__workerDrainProbe__;
    const bridge = globalThis.__omp_call_tool__;
    const pendingHandle = agent("caught", { agent: "task" });
    pendingHandle.catch(async error => {
      probe.pending(error);
      try { probe.stale(await bridge("after_close", {})); }
      catch (failure) { probe.stale(failure); }
    });
    void agent("floating", { agent: "task" });
    print("body-returned"); undefined;`,
  );
  const call = await toolCall("origin", "__agent__");
  await bodyReturned("origin");
  run("parked", 'print("body-returned"); await new Promise(() => {});');
  await bodyReturned("parked");
  const shutdownStart = messages.length;
  const deliverLateReply = receive;
  assert.ok(deliverLateReply);
  dispose();
  const pendingError = await deadline("pending handle rejection on shutdown", pending.promise);
  const staleError = await deadline("new bridge rejection on shutdown", stale.promise);
  assert.ok(pendingError instanceof Error);
  assert.equal(pendingError.name, "ToolError");
  assert.ok(staleError instanceof Error);
  assert.equal(staleError.name, "ToolError");
  await deadline("transport shutdown despite parked local promise", closed.promise);
  deliverLateReply({
    type: "tool-reply",
    id: call.id,
    reply: { ok: true, value: { id: "TooLate", agent: "task" } },
  });
  await Bun.sleep(0);
  await Bun.sleep(0);
  assert.equal(
    messages.some((entry) => entry.type === "tool-call" && entry.name === "after_close"),
    false,
  );
  assert.deepEqual(
    messages.slice(shutdownStart).filter((entry) => entry.type === "result"),
    [],
  );
}

let dispose: (() => void) | undefined;
try {
  const { WorkerCore } = await import("@oh-my-pi/pi-coding-agent/eval/js/worker-core");
  const workerDirectory = dirname(
    Bun.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/eval/js/worker-core")),
  );
  const postmortem: unknown = await import(
    Bun.resolveSync("@oh-my-pi/pi-utils/postmortem", workerDirectory)
  );
  assert.ok(
    typeof postmortem === "object" &&
      postmortem !== null &&
      "interceptUnhandledRejections" in postmortem,
  );
  const registerInterceptor = postmortem.interceptUnhandledRejections;
  assert.ok(typeof registerInterceptor === "function");
  const worker = new WorkerCore(transport, {
    mode: "isolated",
    interceptUnhandledRejections(handler) {
      const unregister: unknown = registerInterceptor(handler);
      assert.ok(typeof unregister === "function");
      return () => {
        unregister();
      };
    },
  });
  dispose = () => worker.dispose();
  send({ type: "init", snapshot });
  await waitFor("ready", (entry) => entry.type === "ready");
  switch (scenario) {
    case "late-success":
      await lateSuccess();
      break;
    case "late-error":
      await lateError(false);
      break;
    case "caught-error":
      await lateError(true);
      break;
    case "chained-requests":
      await chainedRequests(false);
      break;
    case "exported-tool":
      await chainedRequests(true);
      break;
    case "race-local-loser":
      await raceLocalLoser();
      break;
    case "stale-continuation":
      await staleContinuation();
      break;
    case "close":
      await shutdown(() => send({ type: "close" }));
      break;
    case "dispose":
      await shutdown(dispose);
      break;
    default:
      throw new Error(`Unknown WorkerCore regression scenario: ${scenario}`);
  }
  process.stdout.write(`${JSON.stringify({ scenario, result: "passed" })}\n`);
} finally {
  dispose?.();
  if (dispose) await deadline("fixture cleanup", closed.promise);
  Reflect.deleteProperty(globalThis, "__workerDrainProbe__");
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}
