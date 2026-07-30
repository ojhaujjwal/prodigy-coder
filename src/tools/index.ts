import { Effect, Layer } from "effect";
import { Toolkit } from "effect/unstable/ai";
import * as AiError from "effect/unstable/ai/AiError";
import { ShellTool, shellHandler } from "./shell.ts";
import { ReadTool, readHandler } from "./read.ts";
import { WriteTool, writeHandler } from "./write.ts";
import { EditTool, editHandler } from "./edit.ts";
import { GrepTool, grepHandler } from "./grep.ts";
import { GlobTool, globHandler } from "./glob.ts";
import { WebFetchTool, webfetchHandler } from "./webfetch.ts";
import { AskUserTool, makeAskUserHandler } from "./askUser.ts";
import { LoadSkillTool, loadSkillHandler } from "./loadSkill.ts";
import { SkillsRepo } from "../skills.ts";
import { createApprovalGate, DefaultApprovalGateLayer, approvalDeniedError } from "../approval-gate.ts";
import type { ApprovalMode } from "../config.ts";

export const AgenticToolkit = Toolkit.make(
  ShellTool,
  ReadTool,
  WriteTool,
  EditTool,
  GrepTool,
  GlobTool,
  WebFetchTool,
  AskUserTool,
  LoadSkillTool
);

export type AgenticToolkit = typeof AgenticToolkit;

const withLogging =
  <P, C, A, E, R>(toolName: string, handler: (params: P, context: C) => Effect.Effect<A, E, R>) =>
  (params: P, context: C): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      yield* Effect.logDebug(`Tool call: ${toolName}`, params);
      const result = yield* handler(params, context);
      yield* Effect.logDebug(`Tool result: ${toolName}`, result);
      return result;
    }).pipe(
      Effect.catch((error: E) =>
        Effect.gen(function* () {
          yield* Effect.logError(`Tool error: ${toolName} -> ${error}`);
          return yield* Effect.fail(error);
        })
      )
    );

export const withApproval =
  <P, C, A, E, R>(
    toolName: string,
    gate: { approve: (toolName: string, params: unknown) => Effect.Effect<boolean, never, never> },
    handler: (params: P, context: C) => Effect.Effect<A, E, R>
  ) =>
  (params: P, context: C): Effect.Effect<A, E | AiError.AiError, R> =>
    Effect.gen(function* () {
      const approved = yield* gate.approve(toolName, params);
      if (!approved) {
        yield* Effect.logDebug(`Tool approval denied: ${toolName}`);
        return yield* approvalDeniedError(toolName);
      }
      return yield* withLogging(toolName, handler)(params, context);
    });

export const makeToolkitLayer = (config: {
  approvalMode: ApprovalMode;
  nonInteractive: boolean;
  skillsRepoLayer: Layer.Layer<SkillsRepo>;
}): Layer.Layer<import("effect/unstable/ai").Tool.HandlersFor<typeof AgenticToolkit.tools>> => {
  const gate = createApprovalGate({ approvalMode: config.approvalMode, nonInteractive: config.nonInteractive });
  return AgenticToolkit.toLayer({
    shell: withApproval("shell", gate, shellHandler),
    read: withApproval("read", gate, readHandler),
    write: withApproval("write", gate, writeHandler),
    edit: withApproval("edit", gate, editHandler),
    grep: withApproval("grep", gate, grepHandler),
    glob: withApproval("glob", gate, globHandler),
    webfetch: withApproval("webfetch", gate, webfetchHandler),
    ask_user: makeAskUserHandler(config.nonInteractive),
    load_skill: withLogging("load_skill", loadSkillHandler)
  }).pipe(Layer.provide(config.skillsRepoLayer));
};

export const EmptySkillsRepoLayer = SkillsRepo.layer([]);

export const AgenticToolkitLayer = AgenticToolkit.toLayer({
  shell: shellHandler,
  read: readHandler,
  write: writeHandler,
  edit: editHandler,
  grep: grepHandler,
  glob: globHandler,
  webfetch: webfetchHandler,
  ask_user: makeAskUserHandler(false),
  load_skill: loadSkillHandler
}).pipe(Layer.provide(DefaultApprovalGateLayer), Layer.provide(EmptySkillsRepoLayer));

export { ShellTool, ReadTool, WriteTool, EditTool, GrepTool, GlobTool, WebFetchTool, AskUserTool };
