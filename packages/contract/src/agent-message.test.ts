import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  type AgentImageAttachment,
  AgentPrompt,
  MAX_AGENT_IMAGE_ATTACHMENT_BYTES,
  MAX_AGENT_IMAGE_ATTACHMENTS,
  MAX_AGENT_IMAGE_BYTES,
} from "./agent-message.ts";

const decodePrompt = Schema.decodeUnknownSync(AgentPrompt);

const base64ForBytes = (bytes: number) => {
  const completeGroups = Math.floor(bytes / 3);
  const remainder = bytes % 3;
  return `${"AAAA".repeat(completeGroups)}${remainder === 1 ? "AA==" : remainder === 2 ? "AAA=" : ""}`;
};

const image = (data: string, index = 0): AgentImageAttachment => ({
  type: "image",
  name: `image-${index}.png`,
  data,
  mimeType: "image/png",
});
describe("AgentPrompt", () => {
  it("accepts bounded image attachments", () => {
    const data = base64ForBytes(1);
    const prompt = {
      text: "",
      attachments: Array.from({ length: MAX_AGENT_IMAGE_ATTACHMENTS }, (_, index) =>
        image(data, index),
      ),
    };

    assert.deepStrictEqual(decodePrompt(prompt), prompt);
  });

  it("accepts every padding shape near the individual byte limit and the total byte limit", () => {
    for (const bytes of [
      MAX_AGENT_IMAGE_ATTACHMENT_BYTES - 2,
      MAX_AGENT_IMAGE_ATTACHMENT_BYTES - 1,
      MAX_AGENT_IMAGE_ATTACHMENT_BYTES,
    ]) {
      const data = base64ForBytes(bytes);
      const prompt = { text: "", attachments: [image(data), image(data, 1)] };
      assert.deepStrictEqual(decodePrompt(prompt), prompt);
    }
  });

  it("preserves the Base64 alphabet and padding rules", () => {
    for (const data of ["AZaz09+/", "/x==", "A/+="]) {
      const prompt = { text: "", attachments: [image(data)] };
      assert.deepStrictEqual(decodePrompt(prompt), prompt);
    }
    for (const data of ["AA", "AAA", "A===", "AA=A", "AA-_", "AA A", "AA\nA", "AA\u0100A"]) {
      assert.throws(
        () => decodePrompt({ text: "", attachments: [image(data)] }),
        Schema.SchemaError,
      );
    }
  });

  it("rejects a late invalid character or padding without exposing large image payloads", () => {
    const prefix = base64ForBytes(MAX_AGENT_IMAGE_ATTACHMENT_BYTES).slice(0, -4);
    for (const suffix of ["AA!=", "A===", "AA=A"]) {
      let error: unknown;
      try {
        decodePrompt({ text: "", attachments: [image(prefix + suffix)] });
      } catch (cause) {
        error = cause;
      }
      assert.instanceOf(error, Schema.SchemaError);
      if (!(error instanceof Schema.SchemaError))
        throw new Error("Expected image validation failure");
      assert.isBelow(error.message.length, 256);
      assert.notInclude(error.message, suffix);
    }
  });

  it("rejects excessive attachment count, individual bytes, and aggregate bytes", () => {
    const small = base64ForBytes(1);
    assert.throws(() =>
      decodePrompt({
        text: "",
        attachments: Array.from({ length: MAX_AGENT_IMAGE_ATTACHMENTS + 1 }, (_, index) =>
          image(small, index),
        ),
      }),
    );

    assert.throws(() =>
      decodePrompt({
        text: "",
        attachments: [image(base64ForBytes(MAX_AGENT_IMAGE_ATTACHMENT_BYTES + 1))],
      }),
    );

    const aggregatePart = base64ForBytes(Math.floor(MAX_AGENT_IMAGE_BYTES / 3) + 1);
    assert.throws(() =>
      decodePrompt({
        text: "",
        attachments: [image(aggregatePart), image(aggregatePart, 1), image(aggregatePart, 2)],
      }),
    );
  });
});
