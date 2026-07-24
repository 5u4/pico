import { setTimeout as sleep } from "node:timers/promises";
import { StreamFrame, WireChat, WireSpace } from "@pico/web-protocol";
import { Effect, Schema } from "effect";

const base = `http://127.0.0.1:${process.env.PICO_ENGINE_PORT ?? 4319}`;

const request = async <A, I>(
  schema: Schema.Schema<A, I>,
  path: string,
  init?: RequestInit,
): Promise<A> => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body: unknown = await res.json();
  console.log(`${init?.method ?? "GET"} ${path} -> ${res.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok) throw new Error(`request failed: ${path} (${res.status})`);
  return Effect.runPromise(Schema.decodeUnknown(schema)(body));
};

const main = async (): Promise<void> => {
  await sleep(500);

  const space = await request(WireSpace, "/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "smoke", cwd: process.cwd() }),
  });

  const chat = await request(WireChat, `/spaces/${space.id}/chats`, {
    method: "POST",
    body: JSON.stringify({ title: "smoke chat" }),
  });

  console.log(`\n--- opening SSE stream /chats/${chat.id}/events ---`);
  const res = await fetch(`${base}/chats/${chat.id}/events`);
  console.log(
    `status ${res.status} content-type ${res.headers.get("content-type")}`,
  );
  if (!res.body) throw new Error("no SSE body");

  const decodeFrame = Schema.decodeUnknownSync(StreamFrame);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 3000;
  let buffer = "";
  let sawSnapshot = false;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const chunk of buffer.split("\n\n")) {
      if (!chunk.startsWith("data: ")) continue;
      const frame = decodeFrame(JSON.parse(chunk.slice("data: ".length)));
      console.log(`frame: ${frame._tag}`);
      if (frame._tag === "snapshot") sawSnapshot = true;
    }
    if (sawSnapshot) break;
  }
  await reader.cancel();

  if (!sawSnapshot) throw new Error("did not receive snapshot frame");
  console.log("\nsmoke ok: snapshot-first SSE stream observed");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
