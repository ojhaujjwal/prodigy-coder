export type Command =
  | { readonly _tag: "SkillPrefixed"; readonly name: string; readonly prompt: string }
  | { readonly _tag: "NotSlashCommand" };

const SKILL_PREFIX_RE = /^\/skill\s+(\S+)(?:\s+(.+))?$/s;

export const parseCommand = (input: string): Command => {
  const match = SKILL_PREFIX_RE.exec(input);
  if (match) {
    const name = match[1];
    const prompt = match[2] ?? "";
    return name ? { _tag: "SkillPrefixed", name, prompt } : { _tag: "NotSlashCommand" };
  }
  return { _tag: "NotSlashCommand" };
};
