import { Effect, Layer, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { BunServices } from "@effect/platform-bun";
import type { BunServices as BunServicesType } from "@effect/platform-bun/BunServices";
import { Session, type Message } from "../../src/capabilities/session.ts";

/**
 * The real Bun-backed platform services for integration tests: `FileSystem`,
 * `Crypto`, `Path`, `Stdio`, `Terminal`, and `ChildProcessSpawner`.
 *
 * Compose this into a test layer when a test needs real platform authority
 * (temp directories, real randomness, filesystem round-trips). It is the single
 * home for platform layers so later slices merge instead of re-installing.
 */
export const platformLayer: Layer.Layer<BunServicesType> = BunServices.layer;

/**
 * Create a temporary directory that is automatically removed (recursively) when
 * the enclosing `Scope` closes.
 *
 * Requires the real `FileSystem` from {@link platformLayer} plus a `Scope`;
 * `it.effect` from `@effect/vitest` supplies the scope per test.
 */
export const makeTempDirectory = (
  prefix: string
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix });
  });

/**
 * Build a `Session` with the given (already well-formed) raw id and optional
 * messages, for tests that need a session without going through the store's
 * `create` (e.g. to load an id the store has never seen).
 */
export const createTestSession = (
  id: string,
  messages?: Message[],
  createdAt: Date = new Date(0),
  updatedAt: Date = new Date(0)
): Session =>
  Schema.decodeUnknownSync(Session)({
    id,
    messages: messages ?? [],
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString()
  });
