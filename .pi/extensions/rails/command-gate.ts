// User-configurable gate over bash commands. Rules are regex strings matched
// against the command line; see command-rules.example.json for the file format.

export type CommandRules = { deny: string[]; ask: string[]; allow: string[] };
export type Decision = "deny" | "ask" | "allow";

// Project rules override global per-list: a list the project defines replaces
// the global one; a list the project omits falls back to global. An explicit
// empty list is a definition, so it disables the inherited global rule.
export function mergeRules(
  global: Partial<CommandRules>,
  project: Partial<CommandRules>,
): CommandRules {
  const pick = (key: keyof CommandRules): string[] => project[key] ?? global[key] ?? [];
  return { deny: pick("deny"), ask: pick("ask"), allow: pick("allow") };
}

function matchesAny(command: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern).test(command));
}

// Precedence: a deny is absolute; an allow carves out exceptions to a broad
// ask; anything unmatched is allowed, since pi is open by default.
export function classify(command: string, rules: CommandRules): Decision {
  if (matchesAny(command, rules.deny)) return "deny";
  if (matchesAny(command, rules.allow)) return "allow";
  if (matchesAny(command, rules.ask)) return "ask";
  return "allow";
}
