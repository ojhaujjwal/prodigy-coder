import { Context, Effect, Option, Schema } from "effect";

/** A discovered skill's model-facing metadata and content. */
export type Skill = {
  readonly name: SkillName;
  readonly description: string;
  readonly content: string;
  readonly disableModelInvocation: boolean;
};

/** A skill name brand: a non-empty single directory segment. */
export const SkillName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^(?!\.{1,2}$)[^\\/]+$/)),
  Schema.brand("SkillName")
);
export type SkillName = Schema.Schema.Type<typeof SkillName>;

/**
 * The skill authority for the `load_skill` tool: an in-memory index of
 * discovered skills. Discovery and file I/O belong to the adapter; the core
 * contract is lookup by name plus the auto-invokable index.
 */
export class SkillRepository extends Context.Service<
  SkillRepository,
  {
    readonly findByName: (name: SkillName) => Effect.Effect<Option.Option<Skill>>;
    readonly autoInvokable: Effect.Effect<ReadonlyArray<Skill>>;
  }
>()("@prodigy/core/capabilities/skill-repository/SkillRepository") {}
