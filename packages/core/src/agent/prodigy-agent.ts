import { Context, Crypto, Effect, Layer, Stream } from "effect";
import { LanguageModel, Tool } from "effect/unstable/ai";
import { SessionStore } from "../capabilities/session-store.ts";
import { ToolSystemError } from "./agent-error.ts";
import type { AgentError } from "./agent-error.ts";
import type { AgentEvent } from "./agent-event.ts";
import type { AgentProfile } from "./agent-profile.ts";
import { resolveAgentProfile } from "./profile-resolution.ts";
import { coordinateRun } from "./run-coordinator.ts";
import type { RunRequestInput } from "./run-request.ts";

/** The public agent capability for executing lazy Runs. */
export class ProdigyAgent extends Context.Service<
  ProdigyAgent,
  {
    readonly run: (request: RunRequestInput) => Stream.Stream<AgentEvent, AgentError>;
  }
>()("@prodigy/core/agent/prodigy-agent/ProdigyAgent") {}

/**
 * Compose a caller-selected toolkit and its handler Layer into a stable
 * `ProdigyAgent` service.
 *
 * Profile resolution is eager during Layer construction. Session resolution,
 * prompt checkpointing, model work, and Run identity remain lazy until a Run
 * stream is consumed.
 */
export const makeProdigyAgentLayer = <TTools extends Record<string, Tool.Any>>(
  profile: AgentProfile<TTools>
): Layer.Layer<
  ProdigyAgent,
  ToolSystemError,
  | Tool.HandlerServices<TTools[keyof TTools]>
  | Tool.ResultDecodingServices<TTools[keyof TTools]>
  | SessionStore
  | LanguageModel.LanguageModel
  | Crypto.Crypto
> =>
  Layer.effect(
    ProdigyAgent,
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const model = yield* LanguageModel.LanguageModel;
      const crypto = yield* Crypto.Crypto;
      const resolvedProfile = yield* resolveAgentProfile(profile);

      return ProdigyAgent.of({
        run: (request) =>
          coordinateRun(request, {
            store,
            model,
            profile: resolvedProfile,
            crypto
          })
      });
    })
  );
