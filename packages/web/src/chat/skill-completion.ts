import type { SkillCommand } from "@pico/contract/agent-runtime";

export interface SkillToken {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly query: string;
}

export type SkillMenuVisibility = "closed" | "loading" | "empty" | "error" | "ready";

const skillPrefix = "/skill:";
const whitespace = /\s/u;

const isPathLikeToken = (raw: string): boolean => {
  const lower = raw.toLocaleLowerCase();
  return (
    lower.includes("://") ||
    lower.startsWith("//") ||
    lower.includes("\\") ||
    lower.startsWith("/.") ||
    lower.startsWith("/~") ||
    /^\/[a-z]:/iu.test(raw) ||
    raw.slice(1).includes("/")
  );
};

const readTokenBounds = (
  draft: string,
  caret: number,
): {
  readonly start: number;
  readonly end: number;
} => {
  let start = caret;
  while (start > 0 && !whitespace.test(draft[start - 1] ?? "")) start -= 1;
  let end = caret;
  while (end < draft.length && !whitespace.test(draft[end] ?? "")) end += 1;
  return { start, end };
};

export const findSkillToken = (
  draft: string,
  selectionStart: number,
  selectionEnd: number,
): SkillToken | null => {
  if (selectionStart !== selectionEnd) return null;
  if (selectionStart < 0 || selectionStart > draft.length) return null;
  const { start, end } = readTokenBounds(draft, selectionStart);
  if (selectionStart <= start) return null;
  const raw = draft.slice(start, end);
  if (!raw.startsWith("/")) return null;
  if (isPathLikeToken(raw)) return null;
  const typed = draft.slice(start, selectionStart);
  if (skillPrefix.startsWith(typed.toLowerCase())) return { start, end, raw, query: "" };
  return typed.toLowerCase().startsWith(skillPrefix)
    ? { start, end, raw, query: typed.slice(skillPrefix.length) }
    : { start, end, raw, query: typed.slice(1) };
};

export const filterSkills = (
  catalog: readonly SkillCommand[],
  query: string,
): readonly SkillCommand[] => {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return catalog;
  return catalog.filter((skill) => {
    const name = skill.name.toLocaleLowerCase();
    return name.includes(normalized) || skill.description.toLocaleLowerCase().includes(normalized);
  });
};

export const applySkill = (
  draft: string,
  token: Pick<SkillToken, "start" | "end">,
  skillName: string,
): {
  readonly text: string;
  readonly caret: number;
} => {
  const replacement = `/skill:${skillName} `;
  return {
    text: `${draft.slice(0, token.start)}${replacement}${draft.slice(token.end)}`,
    caret: token.start + replacement.length,
  };
};
