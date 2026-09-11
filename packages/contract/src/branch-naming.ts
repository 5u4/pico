import * as Context from "effect/Context";
import type { ChatId } from "./chat-model.ts";

export interface BranchNamingRequest {
  readonly chatId: ChatId;
  readonly generateTopic: () => Promise<string | null>;
}

export type BranchNamingHandler = (request: BranchNamingRequest) => void;

export class BranchNaming extends Context.Service<
  BranchNaming,
  {
    // OMP calls this after the first completed exchange.
    readonly handle: BranchNamingHandler;
  }
>()("@pico/contract/branch-naming/BranchNaming") {}
