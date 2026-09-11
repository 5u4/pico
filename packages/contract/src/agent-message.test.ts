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
