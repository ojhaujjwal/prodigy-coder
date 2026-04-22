import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Effect, Schema } from "effect";
import { AiError, Tool } from "effect/unstable/ai";
import { Toolkit } from "effect/unstable/ai";

const WriteParameters = Schema.Struct({
  filePath: Schema.String,
  content: Schema.String
});

export const WriteTool = Tool.make("write", {
  description: "Write content to a file",
  parameters: WriteParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [FileSystem.FileSystem, Path.Path]
});

export type WriteTool = typeof WriteTool;

export const writeHandler = (
  { filePath, content }: { filePath: string; content: string },
  _context: Toolkit.HandlerContext<typeof WriteTool>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const dir = path.dirname(filePath);
    if (dir && dir !== ".") {
      yield* fs.makeDirectory(dir, { recursive: true });
    }
    yield* fs.writeFileString(filePath, content);
    return `Written to ${filePath}`;
  }).pipe(
    Effect.mapError((error) =>
      AiError.make({
        module: "WriteTool",
        method: "writeHandler",
        reason: new AiError.UnknownError({ description: String(error) })
      })
    )
  );
