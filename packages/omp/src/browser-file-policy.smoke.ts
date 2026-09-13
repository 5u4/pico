import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "@effect/vitest";
import { ChatId } from "@pico/contract/chat-model";
import * as Schema from "effect/Schema";
import {
  BrowserUnavailable,
  browserKey,
  prepareBrowserHome,
  sendBrowserCommand,
} from "./browser-cli.ts";
import { makeBrowserManager } from "./browser-manager.ts";
import { BrowserTabs } from "./browser-viewer.ts";

const Result = Schema.Struct({ result: Schema.String });

it("requires a user request for direct file previews before startup or page changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pico-browser-file-policy-"));
  const root = join(directory, "pico");
  const file = join(directory, "preview.html");
  const fileUrl = pathToFileURL(file).href;
  const destinations = [fileUrl, fileUrl.replace("file:", "FiLe:"), ` \t${fileUrl}\r\n`];
  const fileMarker = `local-preview-${crypto.randomUUID()}`;
  const webMarker = "Loopback baseline page";
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(`<!doctype html><title>Web fixture</title><p>${webMarker}</p>`, {
        headers: { "Content-Type": "text/html" },
      }),
  });
  const home = await prepareBrowserHome(root);
  const manager = await makeBrowserManager({ root, idleTimeoutMs: 60_000 });
  const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000004");
  const owner = { chatId, instance: { kind: "main" } } as const;
  const session = browserKey(JSON.stringify([chatId, "main"]));
  const readText = async () => {
    const first = (
      await manager.execute(owner, { op: "eval", script: "document.body.textContent" })
    )[0];
    if (first?.type !== "text") throw new Error("Missing page text");
    return Schema.decodeUnknownSync(Result)(JSON.parse(first.text)).result;
  };
  const readTabs = async () => {
    const first = (await manager.execute(owner, { op: "tabs", action: "list" }))[0];
    if (first?.type !== "text") throw new Error("Missing browser tabs");
    return Schema.decodeUnknownSync(BrowserTabs)(JSON.parse(first.text)).tabs;
  };
  const consentError = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /explicit user request/);
    assert.match(error.message, /userRequested:true/);
    assert.ok(!error.message.includes(file));
    assert.ok(!error.message.includes(fileUrl));
    return true;
  };
  try {
    await writeFile(file, `<!doctype html><title>Local preview</title><p>${fileMarker}</p>`);
    for (const url of destinations) {
      await assert.rejects(manager.execute(owner, { op: "open", url }), consentError);
      await assert.rejects(
        manager.execute(owner, { op: "tabs", action: "new", url }),
        consentError,
      );
      await assert.rejects(
        sendBrowserCommand(home, session, { action: "session_info" }),
        BrowserUnavailable,
      );
      assert.deepEqual(await readdir(join(home.directory, "owners")), []);
    }

    await manager.execute(owner, { op: "open", url: `http://127.0.0.1:${site.port}/` });
    assert.equal(await readText(), webMarker);
    const baselineTabs = await readTabs();
    for (const url of destinations) {
      await assert.rejects(manager.execute(owner, { op: "open", url }), consentError);
      assert.equal(await readText(), webMarker);
      assert.deepEqual(await readTabs(), baselineTabs);
      await assert.rejects(
        manager.execute(owner, { op: "tabs", action: "new", url }),
        consentError,
      );
      assert.equal(await readText(), webMarker);
      assert.deepEqual(await readTabs(), baselineTabs);
    }

    for (const url of destinations) {
      await manager.execute(owner, { op: "open", url, userRequested: true });
      assert.equal(await readText(), fileMarker);
      assert.equal((await readTabs()).find((tab) => tab.active)?.url, fileUrl);
      await manager.execute(owner, { op: "tabs", action: "new", url, userRequested: true });
      assert.equal(await readText(), fileMarker);
      assert.equal((await readTabs()).find((tab) => tab.active)?.url, fileUrl);
    }

    await manager.execute(owner, { op: "tabs", action: "new" });
    await manager.execute(owner, { op: "open" });
    assert.equal((await readTabs()).find((tab) => tab.active)?.url, "about:blank");
    await manager.execute(owner, {
      op: "tabs",
      action: "new",
      url: `http://127.0.0.1:${site.port}/`,
    });
    assert.equal(await readText(), webMarker);
  } finally {
    await manager.dispose();
    await site.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
