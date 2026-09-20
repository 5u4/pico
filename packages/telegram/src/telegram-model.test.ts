import { assert, describe, it } from "@effect/vitest";
import { splitTelegramText } from "./telegram-model.ts";

describe("splitTelegramText", () => {
  it("keeps a base character and combining mark together across the UTF-16 limit", () => {
    const source = `${"a".repeat(4095)}e\u0301tail`;

    const chunks = splitTelegramText(source);

    assert.deepStrictEqual(
      chunks.map((chunk) => chunk.length),
      [4095, 6],
    );
    assert.strictEqual(chunks[1], "e\u0301tail");
    assert.isTrue(chunks.join("") === source, "chunks preserve the exact source");
  });

  it("keeps a ZWJ family together across the UTF-16 limit", () => {
    const source = `${"a".repeat(4094)}\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}tail`;

    const chunks = splitTelegramText(source);

    assert.deepStrictEqual(
      chunks.map((chunk) => chunk.length),
      [4094, 15],
    );
    assert.strictEqual(chunks[1], "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}tail");
    assert.isTrue(chunks.join("") === source, "chunks preserve the exact source");
  });

  it("splits an oversized grapheme into bounded nonempty pieces without breaking surrogate pairs", () => {
    const source = `\u{1f468}${"\u200d\u{1f469}".repeat(3000)}tail`;

    const chunks = splitTelegramText(source);

    assert.isTrue(chunks.join("") === source, "chunks preserve the exact source");
    assert.isTrue(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 4096));
    assert.isTrue(chunks.every((chunk) => !/[\ud800-\udfff]/u.test(chunk)));
    assert.strictEqual(chunks[0]?.slice(0, 2), "\u{1f468}");
    assert.strictEqual(chunks.at(-1)?.slice(-4), "tail");
  });
});
