import type { z } from "zod";
import type { CapabilityDeclaration } from "../../types";

/**
 * A target tool of the Mission Control spec (Appendix E), staged beside the
 * contracts it replaces.
 *
 * These deliberately do NOT call `registerCapability()`. Most v2 names collide
 * with a live v1 name — `create_org` is both the tool Appendix E targets and the
 * contract it absorbs — and the registry is a process singleton keyed by name.
 * Registering both would make the winner depend on module evaluation order.
 *
 * So v2 modules export an inert descriptor. They are wired into the registry in
 * one move at cutover (issue #2884), once the absorbed v1 contracts are gone.
 * Until then they are type-checked, testable, and importable, but not live.
 */
export interface ToolV2<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> extends CapabilityDeclaration<TInput, TOutput> {
  /**
   * The v1 contract names this tool absorbs, exactly as Appendix E lists them.
   * A manifest test joins this against the generated matrix, so a tool that
   * quietly stops carrying one of its sources fails the build.
   */
  absorbs: readonly string[];

  /**
   * Absorbed v1 names whose contract was rewritten IN PLACE under this tool's
   * own Appendix E name, so the v1 name no longer registers anywhere and there
   * is no v1 input left to diff against.
   *
   * This exists because `exhaustive.test.ts` used to infer the situation and
   * skip the field comparison silently. A silent skip is worse than an absent
   * test: it reads as coverage, and it goes quiet at exactly the moment the
   * check matters, which is when a contract has just moved. Three descriptors
   * were relying on that inference, and a nine-field-to-three shrink on
   * `set_preferences` rode through it unnoticed.
   *
   * Declaring it makes the skip a claim the test can check: the name must
   * genuinely no longer resolve, and the file it used to live in must now
   * register this tool's name. An entry for a name that still resolves is a
   * stale declaration and fails, so this cannot become a way to silence a live
   * comparison.
   *
   * Use it only when the descriptor composes its input FROM the live contract
   * (`input: live.input`), where a comparison would diff a schema against
   * itself. When the descriptor builds its own input, point `absorbs` at the
   * live contract's name instead and let the comparison do its work.
   */
  carriedInPlace?: readonly { name: string; why: string }[];

  /**
   * Fields this tool carries under a different name, so a reader can tell a
   * rename from a loss.
   *
   * These are indistinguishable from the outside: `change_member_role.newRole`
   * becoming `role` and `change_member_role.newRole` vanishing look identical to
   * anyone diffing the two schemas, and to `exhaustive.test.ts`, which can only
   * see that a key stopped existing. Declaring the rename is what makes the
   * carry checkable.
   *
   * Renaming is normal here: ADR-025 verb-first names change what a field's
   * context is, and merging four contracts forces at least some renaming where
   * two sources used one word for two things.
   *
   * Optional because a tool with no renames needs no ceremony; `exhaustive.test.ts`
   * requires an entry only for a field it can see has gone missing.
   */
  renames?: readonly {
    from: string;
    source: string;
    to: string;
    why: string;
  }[];

  /**
   * Fields present on an absorbed contract that this tool deliberately does not
   * carry, each with the reason. Absorbing is field-level, not a union: the
   * spec's `Does` column is narrower than the sum of its sources.
   *
   * `create_workspace` absorbs `configure_repo`, but its job is "workspace plus
   * its main repo binding and production branch" — not `configure_repo`'s
   * ingestion settings. Those move to the Ontology → Repositories surface.
   *
   * Empty array means a clean 1:1 carry. Never omit the field: an empty array
   * is a claim that nothing was dropped, and the reviewer can check it.
   */
  drops: readonly { field: string; from: string; why: string }[];
}

/**
 * Declare a v2 tool. Inert by design — see {@link ToolV2}.
 *
 * Carry rules, in order:
 *  1. The name is Appendix E's, verb-first per ADR-025. Never the v1 name.
 *  2. `input`/`output` compose from the absorbed contracts' schemas by import.
 *     Do not retype a schema that already exists — the validation messages on
 *     the originals encode production edge cases (the 18-char agent slug cap
 *     exists so `org_ns.workspace_ns.slug` stays under 32).
 *  3. `sensitivity`, `defaultEffect`, `defaultRoles` and `agent.riskLevel` carry
 *     from the absorbed contract. Where sources disagree, take the strictest and
 *     say so in a comment.
 *  4. `mutates` is carried only after reading the handler. Absent means it
 *     mutates, and the name does not settle it — `recall_memory` reads in its
 *     name and writes three Neo4j statements.
 *  5. Every field an absorbed contract had and this tool does not goes in
 *     `drops` with a reason.
 */
export function defineTool<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(tool: ToolV2<TInput, TOutput>): ToolV2<TInput, TOutput> {
  return tool;
}
