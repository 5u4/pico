import {
  type Bot,
  type InteractionResponse,
  InteractionResponseTypes,
  InteractionTypes,
  MessageFlags,
} from "discordeno";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { type DiscordError, discordError } from "./discord-error.ts";

export type AcknowledgementIntent =
  | {
      readonly kind: "reply";
      readonly visibility: "public" | "private";
    }
  | {
      readonly kind: "update-source-message";
    };

export interface AcknowledgeableInteraction {
  readonly id: bigint;
  readonly token: string;
  acknowledged: boolean;
  readonly type: InteractionTypes;
}

export type InteractionAcknowledger<
  Interaction extends AcknowledgeableInteraction = AcknowledgeableInteraction,
> = (interaction: Interaction, intent: AcknowledgementIntent) => Effect.Effect<void, DiscordError>;

export type SendInteractionResponse = Bot["helpers"]["sendInteractionResponse"];

type AttemptNumber = 1 | 2;

type AttemptSettlement =
  | {
      readonly kind: "fulfilled";
      readonly attempt: AttemptNumber;
      readonly startedAtNanos: bigint;
      readonly settledAtNanos: bigint;
      readonly observedOrder: number;
    }
  | {
      readonly kind: "rejected";
      readonly attempt: 1;
      readonly startedAtNanos: bigint;
      readonly settledAtNanos: bigint;
      readonly observedOrder: number;
      readonly error: DiscordError;
    }
  | {
      readonly kind: "rejected";
      readonly attempt: 2;
      readonly startedAtNanos: bigint;
      readonly settledAtNanos: bigint;
      readonly observedOrder: number;
      readonly error: DiscordError;
      readonly attempt1PendingAtSettlement: boolean;
    };

type AttemptState =
  | {
      readonly kind: "pending";
      readonly startedAtNanos: bigint;
    }
  | {
      readonly kind: "settled";
      readonly settlement: AttemptSettlement;
    };

interface AttemptHandle {
  state: AttemptState;
  readonly settlement: Promise<AttemptSettlement>;
}

type AttemptContext =
  | {
      readonly attempt: 1;
    }
  | {
      readonly attempt: 2;
      readonly first: AttemptHandle;
    };

type AcknowledgementDecision =
  | {
      readonly kind: "fulfilled";
      readonly winningAttempt: AttemptNumber;
      readonly observedOrder: number;
    }
  | {
      readonly kind: "qualified-40060";
      readonly winningAttempt: 2;
      readonly observedOrder: number;
    }
  | {
      readonly kind: "rejected";
      readonly error: DiscordError;
    };

type SafeAttemptEvidence =
  | {
      readonly attempt: AttemptNumber;
      readonly outcome: "not-started";
    }
  | {
      readonly attempt: AttemptNumber;
      readonly outcome: "pending";
      readonly startedAfterAcknowledgementMs: number;
    }
  | {
      readonly attempt: AttemptNumber;
      readonly outcome: "fulfilled";
      readonly startedAfterAcknowledgementMs: number;
      readonly elapsedMs: number;
    }
  | {
      readonly attempt: AttemptNumber;
      readonly outcome: "rejected";
      readonly startedAfterAcknowledgementMs: number;
      readonly elapsedMs: number;
      readonly status?: number;
      readonly discordCode?: number;
    };

interface SafeAcknowledgementEvidence {
  readonly mode: "defer" | "defer-edit";
  readonly decision: AcknowledgementDecision["kind"];
  readonly winningAttempt?: AttemptNumber;
  readonly deliveryAgeAtAcknowledgementMs: number;
  readonly firstStartedAfterAcknowledgementMs?: number;
  readonly hedgeDueAfterFirstStartMs?: number;
  readonly decisionAfterAcknowledgementMs: number;
  readonly attempts: readonly [SafeAttemptEvidence, SafeAttemptEvidence];
}

const HEDGE_AFTER_FIRST_START_MS = 500;
const HEDGE_AT_INTERACTION_AGE_MS = 2_500;
const DISCORD_INITIAL_RESPONSE_WINDOW_MS = 3_000;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const NANOS_PER_MILLISECOND = 1_000_000;

const interactionCreatedAtMs = (id: bigint): number => Number((id >> 22n) + DISCORD_EPOCH_MS);

const elapsedMilliseconds = (startedAtNanos: bigint, endedAtNanos: bigint): number =>
  Number(endedAtNanos - startedAtNanos) / NANOS_PER_MILLISECOND;

const responseFor = (intent: AcknowledgementIntent): InteractionResponse => {
  switch (intent.kind) {
    case "reply":
      return {
        type: InteractionResponseTypes.DeferredChannelMessageWithSource,
        data: intent.visibility === "private" ? { flags: MessageFlags.Ephemeral } : {},
      };
    case "update-source-message":
      return {
        type: InteractionResponseTypes.DeferredUpdateMessage,
      };
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
};

const startAttempt = (options: {
  readonly context: AttemptContext;
  readonly clock: Clock.Clock;
  readonly startedAtNanos: bigint;
  readonly send: () => ReturnType<SendInteractionResponse>;
  readonly nextObservedOrder: () => number;
}): AttemptHandle => {
  const result = Promise.withResolvers<AttemptSettlement>();
  const handle: AttemptHandle = {
    state: { kind: "pending", startedAtNanos: options.startedAtNanos },
    settlement: result.promise,
  };
  const settle = (settlement: AttemptSettlement) => {
    if (handle.state.kind !== "pending") return;
    handle.state = { kind: "settled", settlement };
    result.resolve(settlement);
  };
  const fulfilled = () =>
    settle({
      kind: "fulfilled",
      attempt: options.context.attempt,
      startedAtNanos: options.startedAtNanos,
      settledAtNanos: options.clock.monotonicTimeNanosUnsafe(),
      observedOrder: options.nextObservedOrder(),
    });
  const rejected = (cause: unknown) => {
    const error = discordError("defer-interaction", cause);
    const timing = {
      startedAtNanos: options.startedAtNanos,
      settledAtNanos: options.clock.monotonicTimeNanosUnsafe(),
      observedOrder: options.nextObservedOrder(),
      error,
    };
    settle(
      options.context.attempt === 1
        ? { kind: "rejected", attempt: 1, ...timing }
        : {
            kind: "rejected",
            attempt: 2,
            ...timing,
            attempt1PendingAtSettlement: options.context.first.state.kind === "pending",
          },
    );
  };

  try {
    void options.send().then(fulfilled, rejected);
  } catch (cause) {
    rejected(cause);
  }

  return handle;
};

const settled = (attempt: AttemptHandle): AttemptSettlement | undefined =>
  attempt.state.kind === "settled" ? attempt.state.settlement : undefined;

const successfulDecision = (
  first: AttemptSettlement | undefined,
  second: AttemptSettlement | undefined,
): Exclude<AcknowledgementDecision, { readonly kind: "rejected" }> | undefined => {
  const firstAccepted = first?.kind === "fulfilled" ? first : undefined;
  const secondAccepted =
    second?.kind === "fulfilled" ||
    (second?.kind === "rejected" &&
      second.attempt === 2 &&
      second.error.discordCode === 40_060 &&
      second.attempt1PendingAtSettlement)
      ? second
      : undefined;
  if (firstAccepted !== undefined && secondAccepted !== undefined) {
    if (firstAccepted.observedOrder <= secondAccepted.observedOrder) {
      return {
        kind: "fulfilled",
        winningAttempt: 1,
        observedOrder: firstAccepted.observedOrder,
      };
    }
  } else if (firstAccepted !== undefined) {
    return {
      kind: "fulfilled",
      winningAttempt: 1,
      observedOrder: firstAccepted.observedOrder,
    };
  }
  if (secondAccepted?.kind === "fulfilled") {
    return {
      kind: "fulfilled",
      winningAttempt: 2,
      observedOrder: secondAccepted.observedOrder,
    };
  }
  if (secondAccepted?.kind === "rejected") {
    return {
      kind: "qualified-40060",
      winningAttempt: 2,
      observedOrder: secondAccepted.observedOrder,
    };
  }
  return undefined;
};

const decide = (
  first: AttemptHandle,
  second?: AttemptHandle,
): AcknowledgementDecision | undefined => {
  const firstSettlement = settled(first);
  const secondSettlement = second === undefined ? undefined : settled(second);
  const success = successfulDecision(firstSettlement, secondSettlement);
  if (success !== undefined) return success;
  if (firstSettlement?.kind !== "rejected") return undefined;
  if (second === undefined) return { kind: "rejected", error: firstSettlement.error };
  if (secondSettlement?.kind !== "rejected") return undefined;
  return { kind: "rejected", error: firstSettlement.error };
};

const awaitAttempt = (attempt: AttemptHandle): Effect.Effect<AttemptSettlement> =>
  Effect.promise(() => attempt.settlement);

const awaitDecision = Effect.fn("DiscordAcknowledgement.awaitDecision")(function* (
  first: AttemptHandle,
  second?: AttemptHandle,
) {
  while (true) {
    const decision = decide(first, second);
    if (decision !== undefined) return decision;
    if (second === undefined) {
      yield* awaitAttempt(first);
    } else if (first.state.kind === "pending" && second.state.kind === "pending") {
      yield* Effect.raceFirst(awaitAttempt(first), awaitAttempt(second));
    } else if (first.state.kind === "pending") {
      yield* awaitAttempt(first);
    } else if (second.state.kind === "pending") {
      yield* awaitAttempt(second);
    } else {
      return yield* Effect.die(
        new Error("Discord acknowledgement reached an invalid settled state"),
      );
    }
  }
});

const attemptEvidence = (
  attempt: AttemptNumber,
  handle: AttemptHandle | undefined,
  acknowledgementStartedAtNanos: bigint,
): SafeAttemptEvidence => {
  if (handle === undefined) return { attempt, outcome: "not-started" };
  if (handle.state.kind === "pending") {
    return {
      attempt,
      outcome: "pending",
      startedAfterAcknowledgementMs: elapsedMilliseconds(
        acknowledgementStartedAtNanos,
        handle.state.startedAtNanos,
      ),
    };
  }
  const { settlement } = handle.state;
  const timing = {
    attempt,
    startedAfterAcknowledgementMs: elapsedMilliseconds(
      acknowledgementStartedAtNanos,
      settlement.startedAtNanos,
    ),
    elapsedMs: elapsedMilliseconds(settlement.startedAtNanos, settlement.settledAtNanos),
  };
  return settlement.kind === "fulfilled"
    ? { ...timing, outcome: "fulfilled" }
    : {
        ...timing,
        outcome: "rejected",
        ...(settlement.error.status === undefined ? {} : { status: settlement.error.status }),
        ...(settlement.error.discordCode === undefined
          ? {}
          : { discordCode: settlement.error.discordCode }),
      };
};

const finish = Effect.fn("DiscordAcknowledgement.finish")(function* (options: {
  readonly mode: SafeAcknowledgementEvidence["mode"];
  readonly deliveryAgeAtAcknowledgementMs: number;
  readonly acknowledgementStartedAtNanos: bigint;
  readonly hedgeDueAfterFirstStartMs?: number;
  readonly first?: AttemptHandle;
  readonly second?: AttemptHandle;
  readonly decision: AcknowledgementDecision;
}) {
  const decidedAtNanos = yield* Clock.monotonicTimeNanos;
  const evidence: SafeAcknowledgementEvidence = {
    mode: options.mode,
    decision: options.decision.kind,
    ...(options.decision.kind === "rejected"
      ? {}
      : { winningAttempt: options.decision.winningAttempt }),
    deliveryAgeAtAcknowledgementMs: options.deliveryAgeAtAcknowledgementMs,
    ...(options.first === undefined
      ? {}
      : {
          firstStartedAfterAcknowledgementMs: elapsedMilliseconds(
            options.acknowledgementStartedAtNanos,
            options.first.state.kind === "pending"
              ? options.first.state.startedAtNanos
              : options.first.state.settlement.startedAtNanos,
          ),
        }),
    ...(options.hedgeDueAfterFirstStartMs === undefined
      ? {}
      : { hedgeDueAfterFirstStartMs: options.hedgeDueAfterFirstStartMs }),
    decisionAfterAcknowledgementMs: elapsedMilliseconds(
      options.acknowledgementStartedAtNanos,
      decidedAtNanos,
    ),
    attempts: [
      attemptEvidence(1, options.first, options.acknowledgementStartedAtNanos),
      attemptEvidence(2, options.second, options.acknowledgementStartedAtNanos),
    ],
  };
  if (options.second !== undefined || options.decision.kind === "rejected") {
    const log =
      options.decision.kind === "rejected"
        ? Effect.logWarning("Discord interaction acknowledgement failed")
        : Effect.logInfo("Discord interaction acknowledgement hedged");
    yield* log.pipe(
      Effect.annotateLogs({
        acknowledgementMode: evidence.mode,
        acknowledgementDecision: evidence.decision,
        ...(evidence.winningAttempt === undefined
          ? {}
          : { acknowledgementWinningAttempt: evidence.winningAttempt }),
        deliveryAgeAtAcknowledgementMs: evidence.deliveryAgeAtAcknowledgementMs,
        ...(evidence.firstStartedAfterAcknowledgementMs === undefined
          ? {}
          : {
              firstStartedAfterAcknowledgementMs: evidence.firstStartedAfterAcknowledgementMs,
            }),
        ...(evidence.hedgeDueAfterFirstStartMs === undefined
          ? {}
          : { hedgeDueAfterFirstStartMs: evidence.hedgeDueAfterFirstStartMs }),
        acknowledgementDecisionAfterMs: evidence.decisionAfterAcknowledgementMs,
        acknowledgementAttempts: evidence.attempts,
      }),
    );
  }
  if (options.decision.kind === "rejected") {
    return yield* Effect.fail(options.decision.error);
  }
});

export const make = (sendInteractionResponse: SendInteractionResponse): InteractionAcknowledger =>
  Effect.fn("DiscordAcknowledgement.acknowledgeInteraction")(function* (interaction, intent) {
    const clock = yield* Clock.Clock;
    const wallStartedAtMs = yield* Clock.currentTimeMillis;
    const acknowledgementStartedAtNanos = yield* Clock.monotonicTimeNanos;
    const deliveryAgeAtAcknowledgementMs = wallStartedAtMs - interactionCreatedAtMs(interaction.id);
    const mode = intent.kind === "reply" ? "defer" : "defer-edit";

    if (
      interaction.acknowledged ||
      (intent.kind === "update-source-message" &&
        interaction.type !== InteractionTypes.MessageComponent &&
        interaction.type !== InteractionTypes.ModalSubmit)
    ) {
      return yield* finish({
        mode,
        deliveryAgeAtAcknowledgementMs,
        acknowledgementStartedAtNanos,
        decision: {
          kind: "rejected",
          error: discordError("defer-interaction", undefined),
        },
      });
    }

    const response = responseFor(intent);
    interaction.acknowledged = true;
    let observedOrder = 0;
    const nextObservedOrder = () => {
      observedOrder += 1;
      return observedOrder;
    };
    const firstStartedAtNanos = clock.monotonicTimeNanosUnsafe();
    const first = startAttempt({
      context: { attempt: 1 },
      clock,
      startedAtNanos: firstStartedAtNanos,
      send: () => sendInteractionResponse(interaction.id, interaction.token, response),
      nextObservedOrder,
    });
    const ageAtFirstStartMs =
      deliveryAgeAtAcknowledgementMs +
      elapsedMilliseconds(acknowledgementStartedAtNanos, firstStartedAtNanos);
    const hedgeDueAfterFirstStartMs = Math.max(
      0,
      Math.min(HEDGE_AFTER_FIRST_START_MS, HEDGE_AT_INTERACTION_AGE_MS - ageAtFirstStartMs),
    );
    const hedgeDueAtNanos =
      firstStartedAtNanos + BigInt(Math.round(hedgeDueAfterFirstStartMs * NANOS_PER_MILLISECOND));
    const waitForHedge = Effect.gen(function* () {
      const sleepRegisteredAtNanos = yield* Clock.monotonicTimeNanos;
      const remainingNanos = hedgeDueAtNanos - sleepRegisteredAtNanos;
      yield* Effect.sleep(remainingNanos > 0n ? remainingNanos : 0n);
    }).pipe(Effect.as("hedge"));
    const firstPhase = yield* Effect.raceFirst(
      awaitAttempt(first).pipe(Effect.as("settled")),
      waitForHedge,
    );
    if (firstPhase === "settled" || first.state.kind === "settled") {
      return yield* finish({
        mode,
        deliveryAgeAtAcknowledgementMs,
        acknowledgementStartedAtNanos,
        hedgeDueAfterFirstStartMs,
        first,
        decision: yield* awaitDecision(first),
      });
    }

    const hedgeStartedAtNanos = yield* Clock.monotonicTimeNanos;
    const effectiveAgeAtHedgeMs =
      deliveryAgeAtAcknowledgementMs +
      elapsedMilliseconds(acknowledgementStartedAtNanos, hedgeStartedAtNanos);
    if (
      first.state.kind !== "pending" ||
      effectiveAgeAtHedgeMs >= DISCORD_INITIAL_RESPONSE_WINDOW_MS
    ) {
      return yield* finish({
        mode,
        deliveryAgeAtAcknowledgementMs,
        acknowledgementStartedAtNanos,
        hedgeDueAfterFirstStartMs,
        first,
        decision: yield* awaitDecision(first),
      });
    }

    const second = startAttempt({
      context: { attempt: 2, first },
      clock,
      startedAtNanos: hedgeStartedAtNanos,
      send: () => sendInteractionResponse(interaction.id, interaction.token, response),
      nextObservedOrder,
    });
    return yield* finish({
      mode,
      deliveryAgeAtAcknowledgementMs,
      acknowledgementStartedAtNanos,
      hedgeDueAfterFirstStartMs,
      first,
      second,
      decision: yield* awaitDecision(first, second),
    });
  });
