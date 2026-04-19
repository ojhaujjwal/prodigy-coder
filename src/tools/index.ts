import { Toolkit } from "effect/unstable/ai"
import { ShellTool, shellHandler } from "./shell.ts"
import { ReadTool, readHandler } from "./read.ts"
import { WriteTool, writeHandler } from "./write.ts"
import { EditTool, editHandler } from "./edit.ts"
import { GrepTool, grepHandler } from "./grep.ts"
import { GlobTool, globHandler } from "./glob.ts"
import { WebFetchTool, webfetchHandler } from "./webfetch.ts"

export const MyToolkit = Toolkit.make(
  ShellTool,
  ReadTool,
  WriteTool,
  EditTool,
  GrepTool,
  GlobTool,
  WebFetchTool
)

export type MyToolkit = typeof MyToolkit

export const MyToolkitLayer = MyToolkit.toLayer({
  shell: shellHandler as any,
  read: readHandler as any,
  write: writeHandler as any,
  edit: editHandler as any,
  grep: grepHandler as any,
  glob: globHandler as any,
  webfetch: webfetchHandler as any,
})

export { ShellTool, ReadTool, WriteTool, EditTool, GrepTool, GlobTool, WebFetchTool }