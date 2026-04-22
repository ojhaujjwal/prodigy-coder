import { Effect, Layer, Option } from "effect";
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
import { ApprovalGate, approvalDeniedError } from "../approval-gate.ts";
import { needsApproval } from "../approval.ts";
import type { ApprovalMode } from "../config.ts";

export const MyToolkit = Toolkit.make(
  ShellTool,
  ReadTool,
  WriteTool,
  EditTool,
  GrepTool,
  GlobTool,
  WebFetchTool,
  AskUserTool
);

export type MyToolkit = typeof MyToolkit;

export const withApproval =
  <P, C, A, E, R>(
    toolName: string,
    config: { approvalMode: ApprovalMode; nonInteractive: boolean },
    handler: (params: P, context: C) => Effect.Effect<A, E, R>
  ) =>
  (params: P, context: C): Effect.Effect<A, E | AiError.AiError, R> =>
    Effect.gen(function* () {
      if (!needsApproval(toolName, config.approvalMode)) {
        return yield* handler(params, context);
      }
      // oxlint-disable-next-line prodigy/no-service-option
      const gateOption = yield* Effect.serviceOption(ApprovalGate);
      if (Option.isSome(gateOption)) {
        const approved = yield* gateOption.value.approve(toolName, params);
        if (!approved) {
          return yield* approvalDeniedError(toolName);
        }
      }
      return yield* handler(params, context);
    });

export const makeToolkitLayer = (config: {
  approvalMode: ApprovalMode;
  nonInteractive: boolean;
}): Layer.Layer<import("effect/unstable/ai").Tool.HandlersFor<typeof MyToolkit.tools>> =>
  MyToolkit.toLayer({
    shell: withApproval("shell", config, shellHandler),
    read: withApproval("read", config, readHandler),
    write: withApproval("write", config, writeHandler),
    edit: withApproval("edit", config, editHandler),
    grep: withApproval("grep", config, grepHandler),
    glob: withApproval("glob", config, globHandler),
    webfetch: withApproval("webfetch", config, webfetchHandler),
    ask_user: makeAskUserHandler(config.nonInteractive)
  });

export const MyToolkitLayer = MyToolkit.toLayer({
  shell: shellHandler,
  read: readHandler,
  write: writeHandler,
  edit: editHandler,
  grep: grepHandler,
  glob: globHandler,
  webfetch: webfetchHandler,
  ask_user: makeAskUserHandler(false)
});

export { ShellTool, ReadTool, WriteTool, EditTool, GrepTool, GlobTool, WebFetchTool, AskUserTool };
