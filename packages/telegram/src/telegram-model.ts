import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const canonicalSignedPattern = /^-?(?:0|[1-9][0-9]*)$/u;
const canonicalPositivePattern = /^[1-9][0-9]*$/u;
const externalBindingPattern = /^(-?(?:0|[1-9][0-9]*))\.([1-9][0-9]*)$/u;

const SignedTelegramId = Schema.String.check(
  Schema.isPattern(canonicalSignedPattern),
  Schema.isTrimmed(),
  Schema.makeFilter((value) => value !== "-0", {
    expected: "a canonical signed decimal identifier",
  }),
);

const TopicId = Schema.Int.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0, {
    expected: "a positive safe integer",
  }),
);

export const TelegramAddress = Schema.Struct({
  chatId: SignedTelegramId,
  topicId: TopicId,
});
export type TelegramAddress = typeof TelegramAddress.Type;

export interface TelegramCommand {
  readonly name: string;
  readonly target: "self" | "other";
  readonly argument: string;
}

interface TelegramInputBase {
  readonly chatId: string;
  readonly userId: string;
  readonly text: string;
  readonly chatTitle: string | null;
  readonly command: TelegramCommand | null;
}

export type TelegramInput =
  | (TelegramInputBase & {
      readonly kind: "forum-topic";
      readonly address: TelegramAddress;
    })
  | (TelegramInputBase & {
      readonly kind: "forum-general";
    })
  | {
      readonly kind: "unsupported";
      readonly reason:
        | "unsupported-update"
        | "missing-author"
        | "bot-author"
        | "sender-chat"
        | "private-chat"
        | "non-forum-chat"
        | "non-supergroup-chat"
        | "other-bot-command"
        | "channel-post"
        | "edited-message";
      readonly chatId: string | null;
      readonly userId: string | null;
    };

export const encodeChatExternalId = ({ chatId, topicId }: TelegramAddress): string =>
  `${chatId}.${topicId}`;

export class TelegramBindingError extends Schema.TaggedError<TelegramBindingError>()(
  "TelegramBindingError",
  {
    message: Schema.String,
  },
) {}

export const decodeChatExternalId = Effect.fn("TelegramModel.decodeChatExternalId")(function* (
  externalId: string,
) {
  const match = externalBindingPattern.exec(externalId);
  if (match === null) {
    return yield* new TelegramBindingError({ message: "Invalid Telegram topic binding" });
  }
  const chatId = match[1] ?? "";
  if (!canonicalSignedPattern.test(chatId) || chatId === "-0") {
    return yield* new TelegramBindingError({ message: "Invalid Telegram chat binding" });
  }
  const topicIdText = match[2] ?? "";
  if (!canonicalPositivePattern.test(topicIdText)) {
    return yield* new TelegramBindingError({ message: "Invalid Telegram topic binding" });
  }
  const topicId = Number(topicIdText);
  if (!Number.isSafeInteger(topicId) || topicId <= 0) {
    return yield* new TelegramBindingError({ message: "Invalid Telegram topic binding" });
  }
  return { chatId, topicId } satisfies TelegramAddress;
});

export const parseChatId = Effect.fn("TelegramModel.parseChatId")(function* (chatId: string) {
  if (!canonicalSignedPattern.test(chatId) || chatId === "-0") {
    return yield* new TelegramBindingError({ message: "Invalid Telegram chat identifier" });
  }
  const numeric = Number(chatId);
  if (!Number.isSafeInteger(numeric)) {
    return yield* new TelegramBindingError({ message: "Invalid Telegram chat identifier" });
  }
  return numeric;
});

const telegramTextLimit = 4096;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const splitTelegramText = (text: string): ReadonlyArray<string> => {
  if (text.length <= telegramTextLimit) return text.length === 0 ? [] : [text];

  const chunks: string[] = [];
  let offset = 0;
  for (const { index, segment } of graphemeSegmenter.segment(text)) {
    const segmentEnd = index + segment.length;
    if (segmentEnd - offset <= telegramTextLimit) continue;

    if (index > offset) {
      chunks.push(text.slice(offset, index));
      offset = index;
    }
    while (segmentEnd - offset > telegramTextLimit) {
      let end = offset + telegramTextLimit;
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
      chunks.push(text.slice(offset, end));
      offset = end;
    }
  }
  if (offset < text.length) chunks.push(text.slice(offset));
  return chunks;
};
