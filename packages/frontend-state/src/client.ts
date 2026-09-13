import { AgentPrompt, type AgentTranscript } from "@pico/contract/agent-message";
import type { ChatId } from "@pico/contract/chat-model";
import type { ApplicationError } from "@pico/contract/errors";
import * as RpcClient from "@pico/rpc/client";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import {
  acknowledgeTranscript,
  emptyLiveChat,
  type LiveChat,
  reduceLiveChat,
} from "./chat-state.ts";

export type { LiveBlock, LiveChat, LiveRun, LiveTool, PendingContent } from "./chat-state.ts";

export type Connection =
  | { readonly kind: "opening" }
  | { readonly kind: "active" }
  | { readonly kind: "unavailable"; readonly cause: Cause.Cause<RpcClientError> };

type Client = Effect.Success<ReturnType<typeof RpcClient.make>>;
interface ChatRecord {
  readonly live: LiveChat;
  readonly transcriptResult: AsyncResult.AsyncResult<
    AgentTranscript,
    ApplicationError | RpcClientError
  >;
}
const decodePrompt = Schema.decodeUnknownEffect(AgentPrompt);

/** Construct once per page and dispose its registry at page shutdown. */
export const make = ({ url }: { readonly url: string }) => {
  const status = Atom.make<Connection>({ kind: "opening" }).pipe(Atom.keepAlive);
  const chatCell = Atom.family((_chatId: ChatId) =>
    Atom.make<ChatRecord>({
      live: emptyLiveChat(),
      transcriptResult: AsyncResult.initial(),
    }).pipe(Atom.keepAlive),
  );

  const lifetime = Atom.make((get) => {
    const registry = get.registry;
    let disposed = false;
    get.addFinalizer(() => {
      disposed = true;
    });

    const update = <A>(atom: Atom.Writable<A>, f: (value: A) => A) => {
      if (!disposed) registry.update(atom, f);
    };
    const recordResponse = () => {
      update(
        status,
        (current): Connection => (current.kind === "opening" ? { kind: "active" } : current),
      );
    };
    const refresh = (chatId: ChatId): void => {
      if (!disposed && registry.getNodes().has(transcriptRead(chatId))) {
        registry.refresh(transcriptRead(chatId));
      }
    };
    const available = Effect.suspend(() => {
      const current = registry.get(status);
      return current.kind === "unavailable" ? Effect.failCause(current.cause) : Effect.void;
    });

    return { update, recordResponse, refresh, available };
  }).pipe(Atom.keepAlive);

  const owner = Atom.make((get) =>
    Effect.gen(function* () {
      const lifecycle = get(lifetime);
      const client = yield* RpcClient.make(url);
      yield* client.Events().pipe(
        Stream.runForEach(({ chatId, event }) =>
          Effect.sync(() => {
            lifecycle.recordResponse();
            const cell = chatCell(chatId);
            if (get.registry.getNodes().has(cell)) {
              lifecycle.update(cell, (state) => ({
                ...state,
                live: reduceLiveChat(
                  state.live,
                  event,
                  Option.getOrNull(AsyncResult.value(state.transcriptResult)),
                ),
              }));
            }
            if (event.type === "message-settled" || event.type === "run-finished") {
              lifecycle.refresh(chatId);
            }
          }),
        ),
        Effect.andThen(Effect.die(new Error("RPC Events stream ended"))),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            lifecycle.update(status, (): Connection => ({ kind: "unavailable", cause }));
          }),
        ),
        Effect.forkScoped,
      );
      return {
        client,
        available: lifecycle.available,
        recordResponse: lifecycle.recordResponse,
      };
    }),
  ).pipe(Atom.keepAlive);

  const connection = Atom.readable((get): Connection => {
    const session = get(owner);
    return session._tag === "Failure" ? { kind: "unavailable", cause: session.cause } : get(status);
  }).pipe(Atom.keepAlive);

  const transcriptRead = Atom.family((chatId: ChatId) =>
    Atom.make((get) => {
      const cell = chatCell(chatId);
      let active = true;
      get.addFinalizer(() => {
        active = false;
      });
      const current = get.once(cell);
      get.set(cell, {
        ...current,
        transcriptResult: AsyncResult.waiting(current.transcriptResult),
      });
      return Effect.gen(function* () {
        const session = yield* get.resultOnce(owner);
        yield* session.available;
        const eligible = get.once(cell).live.pending;
        const messages = yield* session.client.Transcript({ chatId });
        session.recordResponse();
        return { messages, eligible };
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!active) return;
            const current = get.once(cell);
            Atom.batch(() =>
              get.set(
                cell,
                Exit.isSuccess(exit)
                  ? {
                      live: acknowledgeTranscript(
                        current.live,
                        exit.value.messages,
                        exit.value.eligible,
                      ),
                      transcriptResult: AsyncResult.success(exit.value.messages),
                    }
                  : {
                      ...current,
                      transcriptResult: AsyncResult.failureWithPrevious(exit.cause, {
                        previous: Option.some(current.transcriptResult),
                      }),
                    },
              ),
            );
          }),
        ),
        Effect.asVoid,
      );
    }).pipe(Atom.keepAlive, Atom.setLazy(false)),
  );

  const transcript = Atom.family((chatId: ChatId) =>
    Atom.readable(
      (get) => {
        const read = transcriptRead(chatId);
        if (!get.registry.getNodes().has(read)) get.once(read);
        return get(chatCell(chatId)).transcriptResult;
      },
      (refresh) => refresh(transcriptRead(chatId)),
    ).pipe(Atom.keepAlive),
  );

  const live = Atom.family((chatId: ChatId) =>
    Atom.readable((get): LiveChat => {
      const state = get(chatCell(chatId)).live;
      return get(connection).kind === "unavailable" && state.run.kind === "running"
        ? { ...state, run: { kind: "unknown" } }
        : state;
    }).pipe(Atom.keepAlive),
  );

  const command = <Input, Error>(
    chatId: ChatId,
    execute: (client: Client, input: Input) => Effect.Effect<void, Error>,
  ) => {
    const lane = Atom.make<{
      readonly pending: number;
      readonly result: AsyncResult.AsyncResult<void, Error | RpcClientError>;
    }>({ pending: 0, result: AsyncResult.initial() }).pipe(Atom.keepAlive);
    const trigger = Atom.fn<Input>()(
      (input, get) => {
        const lifecycle = get.registry.get(lifetime);
        return Effect.gen(function* () {
          get.registry.get(chatCell(chatId));
          const session = yield* get.result(owner);
          yield* session.available;
          yield* execute(session.client, input);
          session.recordResponse();
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              lifecycle.update(lane, (current) => {
                const pending = current.pending - 1;
                const waiting = pending > 0;
                const result = AsyncResult.isFailure(current.result)
                  ? AsyncResult.failure(current.result.cause, {
                      previousSuccess: current.result.previousSuccess,
                      waiting,
                    })
                  : Exit.isFailure(exit)
                    ? AsyncResult.failure<void, Error | RpcClientError>(exit.cause, { waiting })
                    : AsyncResult.success<void, Error | RpcClientError>(undefined, { waiting });
                return { pending, result };
              });
              lifecycle.refresh(chatId);
            }),
          ),
        );
      },
      { concurrent: true },
    ).pipe(Atom.keepAlive, Atom.setLazy(false));

    // The concurrent Atom.fn join can omit synchronous exits and fail before siblings finish.
    return Atom.writable(
      (get) => get(lane).result,
      (get, input: Input) => {
        const lifecycle = get.get(lifetime);
        lifecycle.update(lane, (current) => ({
          pending: current.pending + 1,
          result:
            current.pending === 0 ? AsyncResult.initial(true) : AsyncResult.waiting(current.result),
        }));
        get.set(trigger, input);
      },
    ).pipe(Atom.keepAlive);
  };

  const send = Atom.family((chatId: ChatId) =>
    command(
      chatId,
      Effect.fn("FrontendState.send")(function* (client: Client, prompt: AgentPrompt) {
        const validated = yield* decodePrompt(prompt);
        yield* client.SendMessage({ chatId, prompt: validated });
      }),
    ),
  );
  const abort = Atom.family((chatId: ChatId) =>
    command(
      chatId,
      Effect.fn("FrontendState.abort")(function* (client: Client, _input: undefined) {
        yield* client.Abort({ chatId });
      }),
    ),
  );

  return { connection, transcript, live, send, abort } as const;
};
