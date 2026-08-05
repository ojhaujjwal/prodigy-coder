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

describe("agentErrorFromSessionError", () => {
  it("projects a missing session to agent SessionNotFound", () => {
    const error = new SessionLookupError({ reason: new StoreSessionNotFound({ id: "missing" }) });
    expect(agentErrorFromSessionError(error)).toMatchObject({ _tag: "SessionNotFound", sessionId: "missing" });
  });

  it("projects every session storage reason to the agent family", () => {
    const cases = [
      [new SessionPersistenceError({ reason: new SessionConflict({ id: "conflict" }) }), "conflict"],
      [
        new SessionPersistenceError({ reason: new SessionEncodeFailure({ id: "encode", cause: new Error("encode") }) }),
        "encode"
      ],
      [
        new SessionPersistenceError({ reason: new SessionWriteFailure({ id: "write", cause: new Error("write") }) }),
        "write"
      ],
      [
        new SessionPersistenceError({ reason: new SessionReadFailure({ id: "read", cause: new Error("read") }) }),
        "read"
      ],
      [
        new SessionPersistenceError({ reason: new SessionDecodeFailure({ id: "decode", cause: new Error("decode") }) }),
        "decode"
      ],
      [
        new SessionLookupError({ reason: new SessionReadFailure({ id: "lookup-read", cause: new Error("read") }) }),
        "read"
      ],
      [
        new SessionLookupError({
          reason: new SessionDecodeFailure({ id: "lookup-decode", cause: new Error("decode") })
        }),
        "decode"
      ]
    ] as const;

    for (const [error, reason] of cases) {
      expect(agentErrorFromSessionError(error)).toMatchObject({ _tag: "SessionStorageError", reason });
    }
  });
});
