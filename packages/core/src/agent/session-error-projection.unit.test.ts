import { describe, expect } from "@effect/vitest";
import { it } from "vitest";
import {
  SessionConflict,
  SessionDecodeFailure,
  SessionEncodeFailure,
  SessionLookupError,
  SessionNotFound as StoreSessionNotFound,
  SessionPersistenceError,
  SessionReadFailure,
  SessionWriteFailure
} from "../capabilities/session-store.ts";
import { agentErrorFromSessionError } from "./agent-error.ts";
import { SessionId } from "../capabilities/session.ts";

const sessionId = (value: string) => SessionId.make(value);

describe("agentErrorFromSessionError", () => {
  it("projects a missing session to agent SessionNotFound", () => {
    const error = new SessionLookupError({ reason: new StoreSessionNotFound({ id: sessionId("missing1") }) });
    expect(agentErrorFromSessionError(error)).toMatchObject({ _tag: "SessionNotFound", id: "missing1" });
  });

  it("projects every session storage reason to the agent family", () => {
    const cases = [
      [new SessionPersistenceError({ reason: new SessionConflict({ id: sessionId("conflict") }) }), "Conflict"],
      [
        new SessionPersistenceError({
          reason: new SessionEncodeFailure({ id: sessionId("encode01"), cause: new Error("encode") })
        }),
        "Encode"
      ],
      [
        new SessionPersistenceError({
          reason: new SessionWriteFailure({ id: sessionId("write001"), cause: new Error("write") })
        }),
        "Write"
      ],
      [
        new SessionPersistenceError({
          reason: new SessionReadFailure({ id: sessionId("read0001"), cause: new Error("read") })
        }),
        "Read"
      ],
      [
        new SessionPersistenceError({
          reason: new SessionDecodeFailure({ id: sessionId("decode01"), cause: new Error("decode") })
        }),
        "Decode"
      ],
      [
        new SessionLookupError({
          reason: new SessionReadFailure({ id: sessionId("lookupr1"), cause: new Error("read") })
        }),
        "Read"
      ],
      [
        new SessionLookupError({
          reason: new SessionDecodeFailure({ id: sessionId("lookupd1"), cause: new Error("decode") })
        }),
        "Decode"
      ]
    ] as const;

    for (const [error, reason] of cases) {
      expect(agentErrorFromSessionError(error)).toMatchObject({ _tag: "SessionStorageError", reason });
    }
  });
});
