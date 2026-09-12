import { z } from "zod";
import { defineTool } from "./_define";
import { tachoBundleGet } from "../tacho.bundle.get";
import { schemaRegistryConfig } from "../schema.registry.config";

/**
 * Appendix E: `get_policy_bundle` — "signed bundle for a host or agent".
 * Absorbs `get_tacho_bundle` and `get_registry_config`.
 *
 * Three carry decisions worth reading before changing this file.
 *
 * 1. **`get_registry_config` is a write, and only its read half carries.**
 *    Despite the `get_` prefix it is mounted at `PUT /schema/registry/config`
 *    and sets `enforcement_mode` / `conformance_floor`; its own file says so.
 *    Setting those is governance, and §14 puts governance mode on the workspace
 *    object — Appendix E's `update_workspace` absorbs `update_workspace_settings`
 *    for exactly that. What belongs *here* is the read: §6.4 puts schemas on
 *    both sides of a tool call, so a connection point that is about to refuse a
 *    non-conforming output has to be told the mode and the floor it is judging
 *    against, and the bundle is how a connection point learns anything. So the
 *    two input fields drop and the three output fields carry.
 *
 * 2. **"or agent" is new, and it is why the subject is a union.** v1 could only
 *    answer for a host. §6.2 gives agents their own identity and credentials,
 *    and §6.11's kill switches deny at agent level, so an agent's connection
 *    point needs its own bundle. The subject is a discriminated union rather
 *    than two optional ids because "exactly one of these" is a rule a schema
 *    should enforce, not a rule a handler should discover.
 *
 * 3. **This tool mutates, and the name says the opposite.** Rule 4 of the carry
 *    rules, met in the wild: `packages/handlers/src/tacho.bundle.get.ts` runs
 *    `tx.update(schema.tachoHosts).set({ lastBundleFetchAt, lastSeenAt,
 *    bundleEtagServed, bundleVersionServed, denyGenerationOrgSeen,
 *    denyGenerationWsSeen })` on every call. The bundle poll *is* the liveness
 *    signal `list_hosts` reports, so the write is the point, not an accident.
 *    `mutates: false` here would let two polls from the same host interleave on
 *    a read-modify-write of the deny generation it has seen.
 */
export const getPolicyBundle = defineTool({
  name: "get_policy_bundle",
  domain: "control",
  description:
    "Fetch the signed policy bundle a host or agent caches and evaluates locally, with the workspace's schema enforcement mode and conformance floor.",
  mode: "sync",
  // v1's tacho half was API-only (machine-to-machine); the registry half was
  // also on MCP and CLI. Reading a bundle reveals what is enforced, never a
  // credential, so the wider set carries.
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,

  absorbs: ["get_tacho_bundle", "get_registry_config"],
  renames: [
    {
      from: "host_enrollment_id",
      source: "get_tacho_bundle",
      to: "hostEnrollmentId",
      why: "the subject became a discriminated union when §6.2 gave agents a bundle of their own, so the host id is now the `host` arm's `hostEnrollmentId`. Carried by reference off `tachoBundleGet.input.shape.host_enrollment_id`, so the `tch_` prefix and its message stay attached; the key is camelCased because this tool is read by the UI as well as by the wire, and `host_enrollment_id` was the machine-to-machine spelling.",
    },
  ],
  drops: [
    {
      field: "enforcementMode",
      from: "get_registry_config",
      why: "the input side only — setting the workspace's enforcement mode is governance and moves to `update_workspace` (Appendix E, §14 Organization). The value is still read back, carried by reference onto this tool's `registry` output.",
    },
    {
      field: "conformanceFloor",
      from: "get_registry_config",
      why: "the input side only — follows enforcementMode, same write, same destination. Read back on the `registry` output with its 0–1 bound intact.",
    },
  ],

  /**
   * `get_registry_config` declares `requiresApproval: true`; that grade was
   * earned by the half of it this tool drops, so it does not carry — gating a
   * host's bundle poll behind a human approval would stall the fleet at every
   * refresh. `riskLevel: "medium"` does carry from it: the bundle states what
   * is enforced, and a stale or wrong one is how enforcement silently weakens.
   */
  agent: { requiresApproval: false, riskLevel: "medium", category: "control" },
  // `get_tacho_bundle` says high, `get_registry_config` says medium. High
  // carries: the bundle names the permissions and deny generations a host
  // enforces on, which is the shape of the workspace's defences.
  sensitivity: "high",
  defaultEffect: "deny",
  // The two sources disagree: `get_registry_config` also granted workspace
  // Owner/Member. The tacho set is stricter and carries — a bundle is fetched
  // by a host authenticating with its own scoped credential, not by a member.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  // See note 3 above. Read the handler before ever changing this.
  mutates: true,

  input: z.object({
    /**
     * Exactly one subject. The host arm carries `hostEnrollmentIdSchema` by
     * reference so the `tch_` prefix and its "a host enrollment public id"
     * message stay attached; the key is camelCased because this tool is read
     * by the UI as well as by the wire, and v1's `host_enrollment_id` spelling
     * was the machine-to-machine convention.
     */
    subject: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("host"),
        hostEnrollmentId: tachoBundleGet.input.shape.host_enrollment_id,
      }),
      z.object({
        kind: z.literal("agent"),
        // New in v2 (§6.2). The agent key, not a principal uuid: the bundle is
        // fetched by the connection point in front of the agent, which knows
        // the agent by the key on its credential.
        agentKey: z.string().min(1),
      }),
    ]),

    /**
     * The cheap-poll etag. Carried with its 128-char cap: an unbounded etag on
     * an unauthenticated-shaped polling endpoint is a free amplification of
     * every request the fleet makes.
     */
    etag: tachoBundleGet.input.shape.etag,
  }),

  /**
   * The bundle half is carried whole rather than field by field. Its
   * `superRefine` — "bundle is present exactly when not_modified is false" — is
   * a cross-field invariant, and a `ZodEffects` cannot be extended, so picking
   * the three fields off it would silently drop the one rule that stops a
   * caller having to guess whether an absent bundle means unchanged or missing.
   */
  output: z.object({
    bundle: tachoBundleGet.output,

    /**
     * The read half of `get_registry_config` (§6.4, §11.8). Carried by
     * reference so `enforcementMode`'s enum stays the registry's own, and
     * `conformanceFloor` keeps its 0–1 bound — a floor outside that range is
     * not a stricter policy, it is an unreachable one.
     */
    registry: z.object({
      registryId: schemaRegistryConfig.output.shape.registryId,
      enforcementMode: schemaRegistryConfig.output.shape.enforcementMode,
      conformanceFloor: schemaRegistryConfig.output.shape.conformanceFloor,
    }),
  }),
});

export type GetPolicyBundleInput = z.output<typeof getPolicyBundle.input>;
export type GetPolicyBundleOutput = z.output<typeof getPolicyBundle.output>;
