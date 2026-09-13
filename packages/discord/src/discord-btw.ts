import * as Markdown from "./discord-markdown.ts";

export const format = ({
  userId,
  question,
  answer,
}: {
  readonly userId: bigint;
  readonly question: string;
  readonly answer: string;
}): ReadonlyArray<Markdown.MarkdownChunk> => {
  const header = `**/btw · <@${userId}>**\n\n`;
  const continuationHeader = `**/btw · <@${userId}> · 续**\n\n`;
  const quoted = question
    .replace(/\r\n?/gu, "\n")
    .replace(/[\\`*_~|<>[\]()#+.!@-]/gu, "\\$&")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return Markdown.split(
    `${quoted}\n\n${answer}`,
    Markdown.DISCORD_MESSAGE_LIMIT - continuationHeader.length,
  ).map((chunk, index) => ({
    ...chunk,
    content: `${index === 0 ? header : continuationHeader}${chunk.content}`,
  }));
};
