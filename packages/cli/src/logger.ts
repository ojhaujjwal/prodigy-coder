import { Duration, Effect, Layer, Logger } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";

const LOG_FILE = "logs/app.log";

export const makeFileLoggerLayer = (): Layer.Layer<never, PlatformError, FileSystem.FileSystem> =>
  Layer.effect(
    Logger.CurrentLoggers,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists("logs");
      if (!exists) {
        yield* fs.makeDirectory("logs", { recursive: true });
      }
      const fileLogger = yield* Logger.formatLogFmt.pipe(
        Logger.toFile(LOG_FILE, { flag: "a", batchWindow: Duration.millis(100) })
      );
      const currentLoggers = yield* Logger.CurrentLoggers;
      return new Set([...currentLoggers, fileLogger]);
    })
  );
