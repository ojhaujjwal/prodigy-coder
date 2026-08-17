import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { makeProdigyAgentLayer } from "../../src/agent/prodigy-agent.ts";
import { SkillName } from "../../src/capabilities/skill-repository.ts";
import { defaultAgenticProfile } from "../../src/toolkit/default-toolkit.ts";
import {
  scriptedCommandExecutorLayer,
  scriptedInteractionLayer,
  scriptedSkillRepositoryLayer,
  scriptedWorkspaceLayer
} from "./agent-helpers.ts";
import { finish, runWithWireServer, storeLayer } from "./wire-run.ts";

const capabilityLayers = () =>
  Layer.mergeAll(
    scriptedWorkspaceLayer({ "a.txt": "hello world" }).layer,
    scriptedCommandExecutorLayer({ "bash -c echo hi": { exitCode: 0, stdout: "hi\n", stderr: "" } }).layer,
    scriptedInteractionLayer([{ _tag: "Answered", answer: "42" }]).layer,
    scriptedSkillRepositoryLayer([
      {
        name: SkillName.make("grill"),
        description: "Grills you",
        content: "Interview relentlessly.",
        disableModelInvocation: false
      }
    ]),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die(new Error("webfetch not stubbed")))
    )
  );

describe("Default agentic toolkit", () => {
  it.effect("executes read, shell, and ask_user through the capability services", () =>
    Effect.gen(function* () {
      const agentLayer = Layer.provideMerge(
        Layer.provideMerge(makeProdigyAgentLayer(defaultAgenticProfile()), storeLayer),
        capabilityLayers()
      );
      const { events } = yield* runWithWireServer(
        [
          [{ type: "tool-call", id: "c1", name: "read", params: { filePath: "a.txt" } }, finish("tool-calls")],
          [{ type: "tool-call", id: "c2", name: "shell", params: { command: "echo hi" } }, finish("tool-calls")],
          [{ type: "tool-call", id: "c3", name: "ask_user", params: { question: "what?" } }, finish("tool-calls")],
          [{ type: "text-delta", delta: "done" }, finish("stop")]
        ],
        agentLayer,
        "Do things"
      );

      const readResult = events.find((e) => e.type === "tool-result" && e.toolName === "read");
      expect(readResult).toMatchObject({ outcome: { _tag: "Success", output: "hello world" } });
      const shellResult = events.find((e) => e.type === "tool-result" && e.toolName === "shell");
      expect(shellResult).toMatchObject({ outcome: { _tag: "Success", output: "hi\n" } });
      const askResult = events.find((e) => e.type === "tool-result" && e.toolName === "ask_user");
      expect(askResult).toMatchObject({ outcome: { _tag: "Success", output: "42" } });
      expect(events.at(-1)?.type).toBe("run-ended");
    })
  );
});
