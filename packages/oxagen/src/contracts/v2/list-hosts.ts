import { z } from "zod";
import { defineTool } from "./_define";
import { tachoHostList } from "../tacho.host.list";

/**
 * Appendix E: `list_hosts`. Absorbs `list_tacho_hosts`. Empty `Does` column, so
 * the v1 job carries whole: the enrolled machines with their status, liveness
 * and counters. `drops` is `[]`.
 *
 * **What this backs.** §14's Agents page shows "enrollment status, and tamper
 * incidents" per agent; `hostSummarySchema` already carries both
 * (`incidentsOpen`, `hooksOk`, `otelOk`, `unobservedSessionsCount`). Those
 * counters are the fleet-health signal §7.1 depends on — a host whose hooks
 * were stripped is why `hooks_removed` exists as a visible revoke outcome — so
 * the summary is carried by reference rather than trimmed to a name and a
 * status.
 *
 * **The one vocabulary wrinkle.** `hostSummarySchema.sessionsCount` and
 * `unobservedSessionsCount` use "session", which §3 admits only as the
 * harness's synonym for run. They are carried under their existing names
 * because renaming a field inside an imported schema means retyping the schema,
 * which is exactly what rule 2 forbids. The rename belongs in
 * `packages/oxagen/src/tacho/schemas.ts` at cutover, once every reader moves at
 * the same time.
 */
export const listHosts = defineTool({
  name: "list_hosts",
  domain: "control",
  description:
    "List the machines enrolled as hosts in this workspace with their status, liveness, and counters.",
  mode: "sync",
  // Unmarked in Appendix E, so the default exposure applies. Unlike
  // `enroll_host` this mints nothing and reveals no credential material, so
  // there is no reason to keep a model out of it.
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,

  absorbs: ["list_tacho_hosts"],
  drops: [],

  // Medium rather than high: a host list names machines and their liveness,
  // never a key or a bundle.
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  /**
   * `list_tacho_hosts` grants org `Member`, which is not a role: `SystemOrgRole`
   * is `Owner | Admin | Compliance | Billing`, and org membership is expressed
   * at workspace scope. It type-checks in v1 only because `registerCapability`
   * infers its argument generically and so skips the excess-property check;
   * `defineTool` takes a declared parameter type and catches it. The invalid
   * key is dropped, which is also the stricter reading. The same key is on
   * `list_tacho_sessions` and should be fixed there before cutover.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  /**
   * Read-only, confirmed against `packages/handlers/src/tacho.host.list.ts`:
   * it opens `withTenantDb` and issues selects only, with no writing helper in
   * its import set. Worth stating because its sibling `get_tacho_bundle` looks
   * equally read-shaped and stamps `lastSeenAt` on every call — see
   * `get-policy-bundle.ts`.
   */
  mutates: false,

  input: z.object({
    status: tachoHostList.input.shape.status,
    // 200-row cap and the opaque cursor carry as a pair: the handler's keyset
    // pagination encodes its position in that cursor, so a different cap here
    // would page past rows the cursor cannot describe.
    limit: tachoHostList.input.shape.limit,
    cursor: tachoHostList.input.shape.cursor,
  }),

  output: z.object({
    hosts: tachoHostList.output.shape.hosts,
    nextCursor: tachoHostList.output.shape.nextCursor,
  }),
});

export type ListHostsInput = z.output<typeof listHosts.input>;
export type ListHostsOutput = z.output<typeof listHosts.output>;
