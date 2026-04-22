import { Toolkit } from "effect/unstable/ai";
import { ShellTool, shellHandler } from "./shell.ts";
import { ReadTool, readHandler } from "./read.ts";
import { WriteTool, writeHandler } from "./write.ts";
import { EditTool, editHandler } from "./edit.ts";
import { GrepTool, grepHandler } from "./grep.ts";
import { GlobTool, globHandler } from "./glob.ts";
import { WebFetchTool, webfetchHandler } from "./webfetch.ts";
import { AskUserTool, makeAskUserHandler } from "./askUser.ts";

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
