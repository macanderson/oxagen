/**
 * A Cedar schema and policies for tacho's own tests. The schema has the
 * shape `@oxagen/policy` writes to `policy/schema.cedarschema`: the full
 * `Call` context, and one action per built-in tool.
 */
import type { CedarBundle } from "../wire";
import { BUILTIN_NAMES } from "./builtins";
import { CEDAR_WASM_VERSION } from "./runtime";

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
  url?: String
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

action ${BUILTIN_NAMES.map((n) => `"builtin__${n}"`).join(", ")}
  appliesTo {
    principal: Agent,
    resource: Target,
    context: Call
  };
`;

/** The grant: every agent may call every built-in tool, so each test policy narrows it. */
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

/** A bundle's `cedar` part with the grant, the given policies, and the three test agents. */
export function testCedarBundle(
  policies: Record<string, string>,
  approvalIds: string[] = [],
): CedarBundle {
  return {
    cedar_version: CEDAR_WASM_VERSION,
    policies: { "grant.builtin": TEST_GRANT, ...policies },
    approval_ids: approvalIds,
    schema: TEST_CEDAR_SCHEMA,
    principals: [
      { ...RELEASE_BOT },
      { ...CI_REVIEWER },
      { ...DOCS_WRITER },
    ],
  };
}
