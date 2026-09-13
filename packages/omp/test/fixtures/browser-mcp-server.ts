import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import * as Schema from "effect/Schema";

const marker = process.argv[2];
assert.ok(marker, "Missing MCP process marker path");
writeFileSync(marker, String(process.pid));
process.on("exit", () => writeFileSync(`${marker}.stopped`, "stopped"));
process.on("SIGTERM", () => process.exit(0));

const Request = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const Initialize = Schema.Struct({ protocolVersion: Schema.String });
const Sum = Schema.Struct({
  name: Schema.Literal("sum"),
  arguments: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
});

for await (const line of createInterface({ input: process.stdin })) {
  const request = Schema.decodeUnknownSync(Request)(JSON.parse(line));
  if (request.id === undefined) continue;
  let result: unknown;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: Schema.decodeUnknownSync(Initialize)(request.params).protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "local-math", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "sum",
            description: "Add two numbers locally",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
              additionalProperties: false,
            },
          },
        ],
      };
      break;
    case "tools/call": {
      const { arguments: args } = Schema.decodeUnknownSync(Sum)(request.params);
      const sum = args.a + args.b;
      appendFileSync(`${marker}.calls`, `${sum}\n`);
      result = { content: [{ type: "text", text: `LOCAL_SUM=${sum}` }] };
      break;
    }
    case "ping":
      result = {};
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        })}\n`,
      );
      continue;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
