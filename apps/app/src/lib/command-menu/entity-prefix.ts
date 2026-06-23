/**
 * entity-prefix.ts
 *
 * Pure (no I/O, no side-effects) matcher recognizing Command Menu entity-prefix
 * patterns as specified in docs/specs/command-menu/spec.md §10.
 *
 * Patterns (case-insensitive):
 *   run [id] | run_ | run #…   → kind: "run"
 *   @email@…                   → kind: "principal"
 *   playbook [slug] | pb_…     → kind: "playbook"
 *   trigger [name] | tg_…      → kind: "trigger"
 *   event [name]               → kind: "event"
 *   agent [name] | ag_…        → kind: "agent"
 */

export type EntityKind =
  | "run"
  | "principal"
  | "playbook"
  | "trigger"
  | "event"
  | "agent";

export interface EntityPrefixMatch {
  kind: EntityKind;
  /** The remainder of the input after the prefix is stripped (trimmed). */
  queryRemainder: string;
}

// Each entry: [prefix-pattern, kind].
// The prefix pattern is applied case-insensitively.
const MATCHERS: Array<{ pattern: RegExp; kind: EntityKind }> = [
  // run # 1234 | run_abc | run abc
  { pattern: /^run[_ #]+/i, kind: "run" },
  // @email — starts with @
  { pattern: /^@/, kind: "principal" },
  // pb_abc or playbook …
  { pattern: /^(?:pb_|playbook\s+)/i, kind: "playbook" },
  // tg_abc or trigger …
  { pattern: /^(?:tg_|trigger\s+)/i, kind: "trigger" },
  // event …
  { pattern: /^event\s+/i, kind: "event" },
  // ag_abc or agent …
  { pattern: /^(?:ag_|agent\s+)/i, kind: "agent" },
];

/**
 * Test `input` against all entity-prefix patterns.
 *
 * Returns the first match as `{ kind, queryRemainder }`, or `null` when no
 * pattern matches.
 */
export function matchEntityPrefix(input: string): EntityPrefixMatch | null {
  const trimmed = input.trimStart();
  for (const { pattern, kind } of MATCHERS) {
    const match = pattern.exec(trimmed);
    if (match) {
      return {
        kind,
        queryRemainder: trimmed.slice(match[0].length).trimStart(),
      };
    }
  }
  return null;
}
