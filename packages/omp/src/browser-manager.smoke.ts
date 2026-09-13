import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { ChatId } from "@pico/contract/chat-model";
import * as Schema from "effect/Schema";
import { makeBrowserManager } from "./browser-manager.ts";

const Result = Schema.Struct({ result: Schema.String });
const Value = Schema.Struct({ value: Schema.String });

it("isolates owners, restores saved login, and rejects work admitted before archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-browser-smoke-"));
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        '<!doctype html><title>Browser fixture</title><input id="value"><p>Local login fixture</p>',
        { headers: { "Content-Type": "text/html" } },
      ),
  });
  const url = `http://127.0.0.1:${site.port}/`;
  const manager = await makeBrowserManager({ root, idleTimeoutMs: 60_000 });
  const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000002");
  const main = { chatId, instance: { kind: "main" } } as const;
  const child = { chatId, instance: { kind: "child", sessionId: "child-one" } } as const;
  const later = {
    chatId: ChatId.make("018f47a0-0000-7000-8000-000000000003"),
    instance: { kind: "main" },
  } as const;
  const readLogin = async (owner: typeof main | typeof child | typeof later) => {
    const result = await manager.execute(owner, {
      op: "eval",
      script: "JSON.stringify({cookie:document.cookie,storage:localStorage.getItem('login')})",
    });
    const first = result[0];
    if (first?.type !== "text") throw new Error("Missing page evaluation result");
    return Schema.decodeUnknownSync(Result)(JSON.parse(first.text)).result;
  };
  try {
    await Promise.all([
      manager.execute(main, { op: "open", url }),
      manager.execute(child, { op: "open", url }),
    ]);
    await manager.execute(main, {
      op: "eval",
      script: "document.cookie='login=main; path=/';localStorage.setItem('login','main');'saved'",
    });
    assert.strictEqual(await readLogin(child), JSON.stringify({ cookie: "", storage: null }));
    await manager.execute(main, {
      op: "fill",
      selector: "#value",
      text: "--session --cdp --config",
    });
    const filled = (
      await manager.execute(main, { op: "get", what: "value", selector: "#value" })
    )[0];
    if (filled?.type !== "text") throw new Error("Missing field value");
    assert.strictEqual(
      Schema.decodeUnknownSync(Value)(JSON.parse(filled.text)).value,
      "--session --cdp --config",
    );
    await manager.execute(main, { op: "remember_login", userApproved: true });
    await manager.execute(main, { op: "close" });
    await manager.execute(main, { op: "open", url });
    assert.strictEqual(
      await readLogin(main),
      JSON.stringify({ cookie: "login=main", storage: "main" }),
    );
    await manager.execute(later, { op: "open", url });
    assert.strictEqual(
      await readLogin(later),
      JSON.stringify({ cookie: "login=main", storage: "main" }),
    );
    assert.strictEqual(await readLogin(child), JSON.stringify({ cookie: "", storage: null }));
    const pending = manager.execute(child, { op: "reload" });
    const rejected = assert.rejects(pending, /owner closed/);
    await manager.closeChat(chatId);
    await rejected;
    await assert.rejects(manager.execute(main, { op: "open", url }), /owner is closed/);
    await assert.rejects(manager.execute(child, { op: "open", url }), /owner is closed/);
  } finally {
    await manager.dispose();
    await site.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
