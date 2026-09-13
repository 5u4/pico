import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

const UploadedFiles = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({ name: Schema.String, size: Schema.Number, text: Schema.String }),
  ),
});

it("rejects unapproved uploads before startup and uploads approved files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pico-browser-upload-consent-"));
  const root = join(directory, "pico");
  const file = join(directory, `private-${crypto.randomUUID()}.txt`);
  const contents = `upload-fixture-${crypto.randomUUID()}`;
  const page = join(directory, "upload.html");
  const home = await prepareBrowserHome(root);
  const manager = await makeBrowserManager({ root, idleTimeoutMs: 60_000 });
  const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000005");
  const owner = { chatId, instance: { kind: "main" } } as const;
  const session = browserKey(JSON.stringify([chatId, "main"]));
  const executeUnchecked = (operation: unknown) => {
    // @ts-expect-error Raw callers can bypass the tool schema; exercise the manager boundary.
    return manager.execute(owner, operation);
  };
  const noBrowserState = async () => {
    await assert.rejects(
      sendBrowserCommand(home, session, { action: "session_info" }),
      BrowserUnavailable,
    );
    assert.deepEqual(await readdir(join(home.directory, "owners")), []);
    assert.deepEqual(await readdir(home.stateDirectory), []);
    assert.deepEqual(await readdir(home.socketDirectory), []);
  };
  const safeError = (error: unknown, message: RegExp) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, message);
    assert.ok(!error.message.includes(file));
    assert.ok(!error.message.includes(basename(file)));
    assert.ok(!error.message.includes(contents));
    return true;
  };
  try {
    await writeFile(file, contents);
    await writeFile(
      page,
      '<!doctype html><title>Upload fixture</title><input id="upload" type="file">',
    );
    for (const approval of [{}, { userApproved: false }]) {
      await assert.rejects(
        executeUnchecked({ op: "upload", selector: "#upload", files: [file], ...approval }),
        (error) => safeError(error, /explicit user approval.*userApproved:true/),
      );
      await noBrowserState();
    }
    await assert.rejects(
      manager.execute(owner, {
        op: "upload",
        selector: "#upload",
        files: [basename(file)],
        userApproved: true,
      }),
      (error) => safeError(error, /paths must be absolute/),
    );
    await noBrowserState();

    await manager.execute(owner, {
      op: "open",
      url: pathToFileURL(page).href,
      userRequested: true,
    });
    await manager.execute(owner, {
      op: "upload",
      selector: "#upload",
      files: [file],
      userApproved: true,
    });
    const first = (
      await manager.execute(owner, {
        op: "eval",
        script:
          'Promise.all(Array.from(document.querySelector("#upload").files, async (file) => ({ name: file.name, size: file.size, text: await file.text() })))',
      })
    )[0];
    if (first?.type !== "text") throw new Error("Missing uploaded file details");
    assert.deepEqual(Schema.decodeUnknownSync(UploadedFiles)(JSON.parse(first.text)).result, [
      { name: basename(file), size: Buffer.byteLength(contents), text: contents },
    ]);
  } finally {
    await manager.dispose();
    await rm(dirname(home.socketDirectory), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
