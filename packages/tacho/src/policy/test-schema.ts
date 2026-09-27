/**
 * A Cedar schema and policies for tacho's own tests. The schema has the
 * shape `@oxagen/policy` writes to `policy/schema.cedarschema`: the full
 * `Call` context, one action per built-in tool, and one imported MCP tool,
 * `billing__create_refund`.
 */
import { createRequire } from "node:module";
import type { CedarBundle, CedarToolEntry } from "../wire";
import { BUILTIN_NAMES } from "./builtins";
import type { CedarRuntime } from "./runtime";

/** The imported tool the test schema declares, and the test bundle lists. */
export const REFUND_ACTION = "billing__create_refund";

export const REFUND_TOOL: CedarToolEntry = {
  version: 2,
  risk: "high",
  side_effect: "irreversible",
  egress: "third_party",
  impacts: ["customer_funds"],
  args: { amount_cents: "Long", customer: "String" },
};

/**
 * What the installed evaluator reports, which a published bundle carries as
 * `cedar_version`. Read from the package, not a constant, so a test bundle
 * always matches the evaluator the tests run.
 */
export function installedCedarVersion(): string {
  const cedar = createRequire(import.meta.url)(
    "@cedar-policy/cedar-wasm/nodejs",
  ) as Pick<CedarRuntime, "getCedarVersion">;
  return cedar.getCedarVersion();
}

export const TEST_CEDAR_SCHEMA = `entity Workspace;

entity Agent in [Workspace] {
  operator: String,
  runtime: String,
  harness: String
};

entity Target;

type Tool = {
  name: String,
  version: Long,
  risk: String,
  side_effect: String,
  egress: String,
  impacts: Set<String>
};

type Args = {
  command?: String,
  path?: String,
  pattern?: String,
  query?: String,
  subagent?: String,
  url?: String,
  amount_cents?: Long,
  customer?: String
};

type Call = {
  tool: Tool,
  args: Args,
  taint: { tainted: Bool, sources: Set<String> },
  time: { hour_utc: Long, weekday: Bool },
  rate: { calls_last_hour: Long, calls_last_minute: Long },
  run: { prior_calls: Set<String>, prior_reads: Set<String> },
  operator: { role: String },
  tier: String,
  budget: { remaining_cents: Long },
  mandate?: { remaining_cents: Long },
  approval: { granted: Bool, approvers: Long },
  harness_tool?: String,
  skill?: String
};

action ${BUILTIN_NAMES.map((n) => `"builtin__${n}"`).join(", ")}, "${REFUND_ACTION}"
  appliesTo {
    principal: Agent,
    resource: Target,
    context: Call
  };
`;

/** The grant: every agent may call every tool, so each test policy narrows it. */
export const TEST_GRANT = `@id("grant.builtin")
permit (principal, action, resource);`;

export const RELEASE_BOT = {
  name: "a-intel.core.release-bot",
  operator: "mac@a-intel.com",
  runtime: "laptop-7",
  harness: "claude-code",
  workspace: "core",
} as const;

export const CI_REVIEWER = {
  name: "a-intel.core.ci-reviewer",
  operator: "mac@a-intel.com",
  runtime: "laptop-7",
  harness: "codex",
  workspace: "core",
} as const;

export const DOCS_WRITER = {
  name: "a-intel.core.docs-writer",
  operator: "mac@a-intel.com",
  runtime: "laptop-7",
  harness: "stella",
  workspace: "core",
} as const;

/**
 * A bundle's `cedar` part with the grant, the given policies, the three test
 * agents, and the imported refund tool.
 */
export function testCedarBundle(
  policies: Record<string, string>,
  approvalIds: string[] = [],
): CedarBundle {
  return {
    cedar_version: installedCedarVersion(),
    policies: { "grant.builtin": TEST_GRANT, ...policies },
    approval_ids: approvalIds,
    schema: TEST_CEDAR_SCHEMA,
    principals: [
      { ...RELEASE_BOT },
      { ...CI_REVIEWER },
      { ...DOCS_WRITER },
    ],
    tools: { [REFUND_ACTION]: { ...REFUND_TOOL, args: { ...REFUND_TOOL.args } } },
  };
}
