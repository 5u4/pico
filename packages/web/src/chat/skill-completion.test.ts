import { assert, describe, it } from "@effect/vitest";
import type { SkillCommand } from "@pico/contract/agent-runtime";
import { applySkill, filterSkills, findSkillToken } from "./skill-completion.ts";

const catalog = [
  { name: "review", description: "Review the selected change" },
  { name: "refactor", description: "Refactor the selected module" },
] as const satisfies readonly SkillCommand[];

describe("skill completion", () => {
  it("parses slash and skill-prefixed tokens at the caret", () => {
    const plain = "Run /rev";
    const plainToken = findSkillToken(plain, plain.length, plain.length);
    assert.deepStrictEqual(plainToken, {
      start: 4,
      end: 8,
      raw: "/rev",
      query: "rev",
    });

    const prefixed = "Run /skill:ref";
    const prefixedToken = findSkillToken(prefixed, prefixed.length, prefixed.length);
    assert.deepStrictEqual(prefixedToken, {
      start: 4,
      end: 14,
      raw: "/skill:ref",
      query: "ref",
    });
  });

  it("keeps skills discoverable while typing their command prefix", () => {
    let draft = "/";
    for (const character of "skill:") {
      draft += character;
      const token = findSkillToken(draft, draft.length, draft.length);
      if (token === null) throw new Error("Expected a skill prefix token");
      assert.deepStrictEqual(filterSkills(catalog, token.query), [
        { name: "review", description: "Review the selected change" },
        { name: "refactor", description: "Refactor the selected module" },
      ]);
    }
    draft += "ref";
    const token = findSkillToken(draft, draft.length, draft.length);
    if (token === null) throw new Error("Expected a skill command token");
    assert.deepStrictEqual(filterSkills(catalog, token.query), [
      { name: "refactor", description: "Refactor the selected module" },
    ]);
    assert.deepStrictEqual(applySkill(draft, token, "refactor"), {
      text: "/skill:refactor ",
      caret: 16,
    });
  });

  it("rejects url and path-like tokens", () => {
    const url = "Use https://example.com";
    assert.isNull(findSkillToken(url, url.length, url.length));

    const unixPath = "Check /Users/sen/project";
    assert.isNull(findSkillToken(unixPath, unixPath.length, unixPath.length));

    const nested = "Look at /skill:review/sub";
    assert.isNull(findSkillToken(nested, nested.length, nested.length));
  });

  it("filters by name and description without case sensitivity", () => {
    assert.deepStrictEqual(filterSkills(catalog, "REV"), [
      { name: "review", description: "Review the selected change" },
    ]);
    assert.deepStrictEqual(filterSkills(catalog, "MODULE"), [
      { name: "refactor", description: "Refactor the selected module" },
    ]);
    assert.deepStrictEqual(filterSkills(catalog, "missing"), []);
  });

  it("replaces only the token and preserves surrounding text", () => {
    const draft = "before /rev after";
    const token = findSkillToken(draft, 11, 11);
    if (token === null) throw new Error("token was expected");
    assert.deepStrictEqual(applySkill(draft, token, "review"), {
      text: "before /skill:review  after",
      caret: 21,
    });
  });

  it("searches only before the caret but replaces the full token", () => {
    const draft = "before /review after";
    const token = findSkillToken(draft, 10, 10);
    assert.deepStrictEqual(token, { start: 7, end: 14, raw: "/review", query: "re" });
    if (token === null) throw new Error("Expected a token");
    assert.deepStrictEqual(applySkill(draft, token, "refactor"), {
      text: "before /skill:refactor  after",
      caret: 23,
    });
    assert.isNull(findSkillToken(draft, 7, 7));
    assert.isNull(findSkillToken(draft, 8, 10));
  });
});
