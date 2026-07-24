import type { WireChat, WireSpace } from "@pico/web-protocol";

export interface WebState {
  readonly spaces: ReadonlyArray<WireSpace>;
  readonly chats: ReadonlyArray<WireChat>;
}

export const emptyWebState: WebState = {
  spaces: [],
  chats: [],
};
