import { z } from "zod";
import { defineTool } from "./_define";
import { tachoEnrollmentCreate } from "../tacho.enrollment.create";

/**
 * Appendix E: `enroll_host` — "device key, host agent, bundle, hooks". Absorbs
 * `create_tacho_enrollment`.
 *
 * A clean 1:1 carry, and the file exists to say so precisely.
 *
 * **Why nothing drops.** Every field on `create_tacho_enrollment` is one of the
 * four things Appendix E names: the device key (`devicePublicKey`), the host
 * agent and what it runs on (`hostname`, `osUser`, `platform`, `osVersion`,
 * `arch`, `harnesses`, `shell`, the harness/runtime version facts), the bundle
 * (`policyBundle`, `bundlePublicKeyPem`), and the hooks the collector installs,
 * which are implied by `harnesses` and reported back later as `hooksOk` on
 * `list_hosts`. So `drops` is `[]` — a claim a reviewer can check, not an
 * omission.
 *
 * **Appendix E names a second source that does not exist.** The row reads
 * "create_tacho_enrollment, create_stella_enrollment (today's names)". There is
 * no `create_stella_enrollment` contract in the registry, and the generated
 * matrix resolves this row to one source. `absorbs` therefore lists one name,
 * matching `docs/mission-control/p1-batches.json`. When a Stella enrollment
 * contract lands it is a second source for this same tool, not a second tool.
 *
 * **Surfaces are deliberately narrower than Appendix E's default.** The
 * appendix exposes every unmarked tool on API, MCP and the UI. `enroll_host`
 * mints the one credential that lets a machine report into the workspace, and
 * `create_api_key`/`rotate_api_key` refuse to mint or preserve its scope
 * precisely so this tool is the only writer of it. MCP is how a model reaches a
 * tool, so exposing it there hands a model the credential-minting path §6.5
 * exists to close. The v1 restriction is the stricter value and it carries;
 * §14.1's `oxagen agent enroll` makes the CLI the second surface.
 */
export const enrollHost = defineTool({
  name: "enroll_host",
  domain: "control",
  description:
    "Enrol a machine as a host: register its device key, mint its scoped host credential, and return the signed enrollment document and initial policy bundle.",
  mode: "sync",
  // No "agent": see the surfaces note above. No "mcp" for the same reason.
  surfaces: ["api", "cli"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  // Enrolling a host consumes no model tokens; the billing gate must not stand
  // between a customer and getting their fleet recording. Carried from v1.
  noBillingGate: true,

  absorbs: ["create_tacho_enrollment"],
  drops: [],

  // Carried unchanged from `create_tacho_enrollment`. No `agent` block: the
  // tool is not on the agent surface, so there is no risk grade to carry.
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  // Writes control.enrollments (Appendix A.6), mints an API key, and signs a
  // bundle. Carried from the source, which is a mutation.
  mutates: true,

  input: z.object({
    // Carried by reference throughout: the device key regex, the 253-char
    // hostname cap (a DNS name's real limit), and the 365-day validity ceiling
    // are production limits that must stay attached to the fields they bound.
    hostname: tachoEnrollmentCreate.input.shape.hostname,
    osUser: tachoEnrollmentCreate.input.shape.osUser,
    platform: tachoEnrollmentCreate.input.shape.platform,
    osVersion: tachoEnrollmentCreate.input.shape.osVersion,
    arch: tachoEnrollmentCreate.input.shape.arch,
    devicePublicKey: tachoEnrollmentCreate.input.shape.devicePublicKey,

    // §7.2: adapters are per harness. The enum is closed today; widening it is
    // a change to the adapter set, not to this contract.
    harnesses: tachoEnrollmentCreate.input.shape.harnesses,
    claudeVersion: tachoEnrollmentCreate.input.shape.claudeVersion,
    claudeExecpath: tachoEnrollmentCreate.input.shape.claudeExecpath,
    nodeVersion: tachoEnrollmentCreate.input.shape.nodeVersion,
    wrapperVersion: tachoEnrollmentCreate.input.shape.wrapperVersion,
    shell: tachoEnrollmentCreate.input.shape.shell,

    managed: tachoEnrollmentCreate.input.shape.managed,
    validityDays: tachoEnrollmentCreate.input.shape.validityDays,
  }),

  output: z.object({
    hostEnrollmentId: tachoEnrollmentCreate.output.shape.hostEnrollmentId,
    agentKey: tachoEnrollmentCreate.output.shape.agentKey,
    apiKeyPublicId: tachoEnrollmentCreate.output.shape.apiKeyPublicId,
    /** Shown once, never recoverable — the carried comment is the contract. */
    apiKey: tachoEnrollmentCreate.output.shape.apiKey,

    // The HMAC-signed document the collector verifies offline, so a host can
    // prove its enrollment without reaching Oxagen.
    enrollment: tachoEnrollmentCreate.output.shape.enrollment,

    // The initial bundle is returned here so a freshly enrolled host can
    // enforce before its first `get_policy_bundle` poll.
    policyBundle: tachoEnrollmentCreate.output.shape.policyBundle,
    bundlePublicKeyPem: tachoEnrollmentCreate.output.shape.bundlePublicKeyPem,
    expiresAt: tachoEnrollmentCreate.output.shape.expiresAt,
  }),
});

export type EnrollHostInput = z.output<typeof enrollHost.input>;
export type EnrollHostOutput = z.output<typeof enrollHost.output>;
