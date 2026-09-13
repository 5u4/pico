import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { MemoryProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/memory-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { getMemoryRoot, saveLearnedLesson } from "@oh-my-pi/pi-coding-agent/memories";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

it("resolves summaries and saved lessons only beneath the caller's custom agentDir", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pico-memory-protocol-"));
  try {
    const root = await realpath(directory);
    const cwd = join(root, "work");
    const agentDir = join(root, "bot", "omp");
    const otherAgentDir = join(root, "other-bot", "omp");
    const memoryRoot = getMemoryRoot(agentDir, cwd);
    const otherMemoryRoot = getMemoryRoot(otherAgentDir, cwd);
    await Promise.all([
      mkdir(memoryRoot, { recursive: true }),
      mkdir(otherMemoryRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(memoryRoot, "memory_summary.md"), "Selected bot summary"),
      writeFile(join(otherMemoryRoot, "memory_summary.md"), "Other bot summary"),
      writeFile(join(otherMemoryRoot, "other-only.md"), "Must not cross bot roots"),
      saveLearnedLesson(agentDir, cwd, { content: "Keep the selected bot's decision" }),
      saveLearnedLesson(otherAgentDir, cwd, { content: "Other bot's private decision" }),
    ]);

    const handler = new MemoryProtocolHandler();
    const agentRegistry = new AgentRegistry();
    const context = { agentDir, cwd, agentRegistry };
    const summary = await handler.resolve(parseInternalUrl("memory://root"), context);
    assert.equal(summary.content, "Selected bot summary");
    assert.equal(summary.sourcePath, join(memoryRoot, "memory_summary.md"));

    const learned = await handler.resolve(parseInternalUrl("memory://root/learned.md"), context);
    assert.equal(learned.sourcePath, join(memoryRoot, "learned.md"));
    assert.match(learned.content, /Keep the selected bot's decision/);
    assert.doesNotMatch(learned.content, /Other bot's private decision/);
    await assert.rejects(handler.resolve(parseInternalUrl("memory://root/other-only.md"), context));

    const other = await handler.resolve(parseInternalUrl("memory://root"), {
      ...context,
      agentDir: otherAgentDir,
    });
    assert.equal(other.content, "Other bot summary");
    assert.equal(other.sourcePath, join(otherMemoryRoot, "memory_summary.md"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
