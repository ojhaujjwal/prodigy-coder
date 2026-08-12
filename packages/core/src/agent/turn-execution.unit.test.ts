import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Toolkit } from "effect/unstable/ai";
import type { SessionCheckpoint, SessionSnapshot } from "../capabilities/session.ts";
import { Session, SessionRevision } from "../capabilities/session.ts";
import { SessionStore as SessionStoreService } from "../capabilities/session-store.ts";
import { PositiveInt, type AgentProfile } from "./agent-profile.ts";
import { resolveAgentProfile } from "./profile-resolution.ts";
import { executeTurn } from "./turn-execution.ts";

const finishPart = {
  type: "finish" as const,
  reason: "stop" as const,
  usage: {
    inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  },
  response: undefined
};

it.effect("streams one turn and commits one completed checkpoint", () =>
  Effect.gen(function* () {
    const created = Schema.decodeUnknownSync(Session)({
      id: "abc12345",
      messages: [{ role: "user", content: "hello" }],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    });
    const initial: SessionSnapshot = { session: created, revision: SessionRevision.make(0) };
    const saved: Array<SessionCheckpoint> = [];
    const store = SessionStoreService.of({
      create: () => Effect.die("unused"),
      load: () => Effect.die("unused"),
      save: (checkpoint) =>
        Effect.sync(() => {
          saved.push(checkpoint);
          return {
            session: { ...checkpoint.session, updatedAt: new Date(1) },
            revision: SessionRevision.make(checkpoint.expectedRevision + 1)
          };
        })
    });
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => Stream.fromIterable([{ type: "text-delta", id: "text-1", delta: "done" }, finishPart])
    });
    const profileInput: AgentProfile<{}> = {
      toolkit: Toolkit.empty,
      toolkitHandlerLayer: Layer.empty,
      systemPrompt: "",
      maxTurns: PositiveInt.make(2)
    };
    const profile = yield* resolveAgentProfile(profileInput);

    const execution = yield* executeTurn(store, model, profile, initial, 1);
    const events = yield* execution.stream.pipe(Stream.runCollect);
    const outcome = yield* execution.outcome;

    expect(events.map((event) => event.type)).toEqual(["turn-started", "text-delta"]);
    expect(outcome._tag).toBe("Finished");
    if (outcome._tag === "Finished") {
      expect(outcome.finishReason).toBe("stop");
      expect(outcome.snapshot.revision).toBe(1);
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]?.session.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "done" }
    ]);
  })
);
