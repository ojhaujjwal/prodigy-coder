import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { SessionStore } from "../../src/capabilities/session-store.ts";
import { makeProdigyAgentLayer } from "../../src/agent/prodigy-agent.ts";
import { PositiveInt } from "../../src/agent/agent-profile.ts";
import { textProfile } from "./agent-helpers.ts";
import { finish, runWithWireServer, storeLayer } from "./wire-run.ts";

describe("Provider prompt contract", () => {
  it.effect("the first model request contains exactly one user prompt — no duplication", () =>
    Effect.gen(function* () {
      const { events, server } = yield* runWithWireServer(
        [[{ type: "text-delta", delta: "Hello" }, finish("stop")]],
        Layer.provideMerge(makeProdigyAgentLayer(textProfile()), storeLayer),
        "Hello"
      );
      expect(events.some((e) => e.type === "run-ended")).toBe(true);

      expect(server.calls).toHaveLength(1);
      const requestBody = JSON.stringify(server.calls[0]);
      expect(requestBody.match(/"role":"user"/g)).toHaveLength(1);
      expect(requestBody).not.toContain('"role":"system"');
    })
  );

  it.effect("a profile systemPrompt seeds the transcript and reaches the model as a system message", () =>
    Effect.gen(function* () {
      const { events, server, context } = yield* runWithWireServer(
        [[{ type: "text-delta", delta: "Hello" }, finish("stop")]],
        Layer.provideMerge(makeProdigyAgentLayer(textProfile(PositiveInt.make(50), "You are a pirate")), storeLayer),
        "Ahoy"
      );
      expect(events.some((e) => e.type === "run-ended")).toBe(true);

      expect(server.calls).toHaveLength(1);
      const requestBody = JSON.stringify(server.calls[0]);
      expect(requestBody.match(/"role":"system"/g)).toHaveLength(1);
      expect(requestBody).toContain("You are a pirate");

      const started = events.find((e) => e.type === "run-started");
      if (started?.type !== "run-started") throw new Error("expected run-started");
      const store = Context.get(context, SessionStore);
      const snapshot = yield* store.load(started.sessionId);
      expect(snapshot.session.messages[0]).toEqual({ role: "system", content: "You are a pirate" });
    })
  );
});
