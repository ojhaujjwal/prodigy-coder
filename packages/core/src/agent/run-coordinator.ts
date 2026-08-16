import { Crypto, Effect, Stream } from "effect";
import { LanguageModel, Tool } from "effect/unstable/ai";
import type { SessionSnapshot, SessionInitial } from "../capabilities/session.ts";
import { checkpointWithMessages } from "../capabilities/session.ts";
import { SessionStore } from "../capabilities/session-store.ts";
import { agentErrorFromSessionError, type AgentError } from "./agent-error.ts";
import type { AgentEvent } from "./agent-event.ts";
import type { ResolvedAgentProfile } from "./profile-resolution.ts";
import { decodeRunRequest, generateRunId, type RunRequest } from "./run-request.ts";
import { executeTurn, type TurnOutcome } from "./turn-execution.ts";

/** The stable dependencies required to coordinate one Run. */
export type RunCoordinatorDependencies<TTools extends Record<string, Tool.Any>> = {
  readonly store: SessionStore["Service"];
  readonly model: LanguageModel.LanguageModel["Service"];
  readonly profile: ResolvedAgentProfile<TTools>;
  readonly crypto: Crypto.Crypto;
};

const resolveSession = (
  sessionId: RunRequest["sessionId"],
  store: SessionStore["Service"],
  systemPrompt: string
): Effect.Effect<SessionSnapshot, AgentError> =>
  Effect.gen(function* () {
    const initial: SessionInitial = systemPrompt === "" ? {} : { systemPrompt };
    if (sessionId === undefined) {
      const snapshot = yield* store.create(initial).pipe(Effect.mapError(agentErrorFromSessionError));
      return {
        ...snapshot,
        session: { ...snapshot.session, messages: [...snapshot.session.messages] }
      };
    }
    const snapshot = yield* store.load(sessionId).pipe(Effect.mapError(agentErrorFromSessionError));
    return {
      ...snapshot,
      session: { ...snapshot.session, messages: [...snapshot.session.messages] }
    };
  });

const checkpointUserPrompt = (
  store: SessionStore["Service"],
  snapshot: SessionSnapshot,
  prompt: string
): Effect.Effect<SessionSnapshot, AgentError> =>
  store
    .save(checkpointWithMessages(snapshot, [{ role: "user", content: prompt }]))
    .pipe(Effect.mapError(agentErrorFromSessionError));

const stoppedEvent = (sessionId: SessionSnapshot["session"]["id"], turns: number, limit: number): AgentEvent => ({
  type: "run-ended",
  result: {
    _tag: "Stopped",
    sessionId,
    turns,
    reason: "max-turns",
    limit
  }
});

/**
 * Coordinate the lazy lifecycle of one Run.
 *
 * Request parsing, session work, prompt checkpointing, turn sequencing, and
 * terminal Run events all remain inside the suspended stream. Nothing starts
 * until the caller consumes the returned stream.
 */
export const coordinateRun = <TTools extends Record<string, Tool.Any>>(
  request: RunRequest,
  dependencies: RunCoordinatorDependencies<TTools>
): Stream.Stream<AgentEvent, AgentError> =>
  Stream.suspend(() =>
    Stream.unwrap(
      Effect.gen(function* () {
        const validatedRequest = yield* decodeRunRequest(request);
        const effectiveMaxTurns =
          validatedRequest.maxTurns === undefined ? dependencies.profile.maxTurns : validatedRequest.maxTurns;

        let snapshot = yield* resolveSession(
          validatedRequest.sessionId,
          dependencies.store,
          dependencies.profile.systemPrompt
        );
        const runId = yield* generateRunId.pipe(Effect.provideService(Crypto.Crypto, dependencies.crypto));
        snapshot = yield* checkpointUserPrompt(dependencies.store, snapshot, validatedRequest.prompt);
        const sessionId = snapshot.session.id;

        const continueAfterTurn = (turn: number, outcome: TurnOutcome): Stream.Stream<AgentEvent, AgentError> => {
          snapshot = outcome.snapshot;
          switch (outcome._tag) {
            case "ToolCalls":
              return runTurns(turn + 1);
            case "Finished": {
              const finishedEvent: AgentEvent = {
                type: "run-ended",
                result: {
                  _tag: "Finished",
                  sessionId,
                  turns: turn,
                  finishReason: outcome.finishReason
                }
              };
              return Stream.succeed(finishedEvent);
            }
            case "Incomplete":
              return turn >= effectiveMaxTurns
                ? Stream.succeed(stoppedEvent(sessionId, turn, effectiveMaxTurns))
                : runTurns(turn + 1);
          }
        };

        const runTurns = (turn: number): Stream.Stream<AgentEvent, AgentError> => {
          if (turn > effectiveMaxTurns) {
            return Stream.succeed(stoppedEvent(sessionId, turn - 1, effectiveMaxTurns));
          }
          return Stream.unwrap(
            executeTurn(dependencies.store, dependencies.model, dependencies.profile, snapshot, turn).pipe(
              Effect.map((execution) =>
                Stream.concat(
                  execution.stream,
                  Stream.unwrap(execution.outcome.pipe(Effect.map((outcome) => continueAfterTurn(turn, outcome))))
                )
              )
            )
          );
        };

        const startedEvent: AgentEvent = { type: "run-started", runId, sessionId };
        return Stream.concat(Stream.succeed(startedEvent), runTurns(1));
      })
    )
  );
