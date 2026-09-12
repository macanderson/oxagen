import type { z } from "zod";
import type { CapabilityDeclaration } from "../../types";

/**
 * A Mission Control target tool (spec Appendix E), staged beside the contracts
 * it replaces.
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
