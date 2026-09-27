/**
 * Fixtures for this package's tests (lane S12): the agents, tools, and rules
 * of the agent policy spec's examples, and a compile that throws on an error.
 * The index does not export this file.
 *
 * The spec's rules are adapted to the contract this lane ships:
 * `financial_class == "moves_funds"` reads `impacts.contains("moves_money")`,
 * `claude_code__Bash` is `builtin__shell`, `claude_code__Edit` is
 * `builtin__write_file`, and a tool version is a Long.
 */
import type { CedarToolEntry } from "@oxagen/tacho";
import type { CedarArgType, CedarRuntime, CedarToolClass } from "@oxagen/tacho/policy";
import { compilePolicies, type AgentDeclaration, type CompiledPolicySet } from "./compile";

export const CORE = "core-platform";
export const FINOPS = "finops";

/** Tuesday 2026-09-22 at 11:30 UTC, inside business hours. */
export const NOW = Date.UTC(2026, 8, 22, 11, 30);

export const RELEASE_BOT: AgentDeclaration = {
  name: "aintel.core.release-bot",
  operator: "priya",
  runtime: "ci-linux-01",
  harness: "claude-code",
};
export const CI_REVIEWER: AgentDeclaration = {
  name: "aintel.core.ci-reviewer",
  operator: "platform-team",
  runtime: "ci-linux-01",
  harness: "codex",
};
export const DOCS_WRITER: AgentDeclaration = {
  name: "aintel.core.docs-writer",
  operator: "priya",
  runtime: "laptop-7",
  harness: "claude-code",
};
export const STELLA_CI: AgentDeclaration = {
  name: "aintel.core.stella-ci",
  operator: "platform-team",
  runtime: "ci-linux-01",
  harness: "stella",
};
export const TRIAGE: AgentDeclaration = {
  name: "aintel.core.triage",
  operator: "priya",
  runtime: "laptop-7",
  harness: "cursor",
};
export const RELEASE_MANAGER: AgentDeclaration = {
  name: "aintel.core.release-manager",
  operator: "priya",
  runtime: "ci-linux-01",
  harness: "codex",
};
export const COST_ANALYST: AgentDeclaration = {
  name: "aintel.core.cost-analyst",
  operator: "finops-team",
  runtime: "laptop-7",
  harness: "stella",
};
export const INVOICE_BOT: AgentDeclaration = {
  name: "aintel.finops.invoice-bot",
  operator: "finops-team",
  runtime: "ci-linux-01",
  harness: "claude-agent-sdk",
};

/** Every agent in the core-platform workspace. */
export const CORE_AGENTS: readonly AgentDeclaration[] = [
  RELEASE_BOT,
  CI_REVIEWER,
  DOCS_WRITER,
  STELLA_CI,
  TRIAGE,
  RELEASE_MANAGER,
  COST_ANALYST,
];

function tool(
  version: number,
  risk: CedarToolClass["risk"],
  side_effect: CedarToolClass["side_effect"],
  egress: CedarToolClass["egress"],
  args: Record<string, CedarArgType>,
  impacts: string[] = [],
): CedarToolEntry {
  return { version, risk, side_effect, egress, impacts, args };
}

/** The tools the spec's examples call, as the signed bundle carries them. */
export const SPEC_TOOLS: Readonly<Record<string, CedarToolEntry>> = {
  aws_billing__purchase_savings_plan: tool(2, "high", "irreversible", "third_party", {}, ["commits_spend"]),
  github__create_pull_request: tool(3, "medium", "write", "third_party", {
    head: "String",
    path: "String",
    repository: "String",
  }),
  github__create_release: tool(2, "medium", "irreversible", "third_party", {
    branch: "String",
    repository: "String",
  }),
  github__delete_branch: tool(1, "medium", "write", "third_party", { branch: "String" }),
  github__delete_repository: tool(1, "critical", "irreversible", "third_party", { repository: "String" }),
  github__get_file_contents: tool(2, "low", "read", "third_party", { path: "String", repository: "String" }),
  kubernetes__delete_pod: tool(2, "high", "irreversible", "org_tenant", { cluster: "String", pod: "String" }),
  kubernetes__get_logs: tool(2, "low", "read", "org_tenant", { pod: "String" }),
  linear__update_issue: tool(3, "low", "write", "third_party", { issue: "String" }),
  slack__post_message: tool(2, "low", "write", "third_party", { channel: "String", text: "String" }),
  slack__upload_file: tool(1, "medium", "write", "third_party", {
    channel: "String",
    recipient_domain: "String",
  }),
  snowflake__run_query: tool(2, "high", "read", "org_tenant", { schema: "String", sql: "String" }),
  stripe__create_payment: tool(
    5,
    "high",
    "irreversible",
    "third_party",
    { amount_cents: "Long", counterparty: "String" },
    ["moves_money"],
  ),
  stripe__create_refund: tool(3, "high", "irreversible", "third_party", { amount_cents: "Long" }, [
    "moves_money",
  ]),
  stripe__list_prices: tool(1, "low", "read", "third_party", {}),
  zendesk__update_ticket: tool(3, "medium", "write", "third_party", { fields: "Set<String>" }),
};

/** The spec's example rules by id, each in the text a steering repo would hold. */
export const SPEC_RULES: Readonly<Record<string, string>> = {
  "reads.open": `// Every agent may call a read-only tool of low or medium risk.
@id("reads.open")
permit (principal, action, resource)
when { context.tool.side_effect == "read" && context.tool.risk != "high" };`,
  "reads.high-risk-routed": `// A high-risk read runs only when the call is routed through the gateway.
@id("reads.high-risk-routed")
forbid (principal, action, resource)
when { context.tool.side_effect == "read" && context.tool.risk == "high" }
unless { ["gateway", "contained"].contains(context.tier) };`,
  "irreversible.approval": `// Every irreversible call parks for a person's approval.
@id("irreversible.approval")
@decision("require_approval")
forbid (principal, action, resource)
when { context.tool.side_effect == "irreversible" }
unless { context.approval.granted };`,
  "slack.external-approval": `// A post or upload to a shared external Slack channel parks for approval.
@id("slack.external-approval")
@decision("require_approval")
forbid (
  principal,
  action in [Action::"slack__post_message", Action::"slack__upload_file"],
  resource
)
when { context.args has channel && context.args.channel like "ext-*" }
unless { context.approval.granted };`,
  "payments.two-approvers": `// A call that moves more than $1,000 needs two approvers.
@id("payments.two-approvers")
@decision("require_approval")
forbid (principal, action, resource)
when {
  context.tool.impacts.contains("moves_money") &&
  context.args has amount_cents &&
  context.args.amount_cents > 100000
}
unless { context.approval.granted && context.approval.approvers >= 2 };`,
  "repo.delete-never": `// No agent deletes a repository. A person does it.
@id("repo.delete-never")
forbid (principal, action == Action::"github__delete_repository", resource);`,
  "refund.over-500": `// A refund above $500 parks for approval.
@id("refund.over-500")
@decision("require_approval")
forbid (principal, action == Action::"stripe__create_refund", resource)
when { context.args has amount_cents && context.args.amount_cents > 50000 }
unless { context.approval.granted };`,
  "payment.vendor-list": `// A payment goes only to a counterparty on the vendor list.
@id("payment.vendor-list")
forbid (principal, action == Action::"stripe__create_payment", resource)
unless { context.args has counterparty && context.args.counterparty like "vendor:*" };`,
  "payment.quote-first": `// A payment is denied unless the same run already priced it.
@id("payment.quote-first")
forbid (principal, action == Action::"stripe__create_payment", resource)
unless { context.run.prior_calls.contains("stripe__list_prices") };`,
  "money.business-hours": `// Money moves only on a weekday between 09:00 and 17:00 UTC.
@id("money.business-hours")
forbid (principal, action, resource)
when { context.tool.impacts.contains("moves_money") }
unless {
  context.time.weekday &&
  context.time.hour_utc >= 9 &&
  context.time.hour_utc < 17
};`,
  "mandate.remaining": `// A payment larger than what is left on its mandate is denied.
@id("mandate.remaining")
forbid (principal, action, resource)
when {
  context.tool.impacts.contains("moves_money") &&
  context has mandate &&
  context.args has amount_cents &&
  context.args.amount_cents > context.mandate.remaining_cents
};`,
  "spend.finops-only": `// Only an agent in finops may call a tool that commits spend.
@id("spend.finops-only")
forbid (principal, action, resource)
when { context.tool.impacts.contains("commits_spend") }
unless { principal in Workspace::"finops" };`,
  "taint.shell": `// Content fetched from the web may not reach a shell command.
@id("taint.shell")
forbid (principal, action == Action::"builtin__shell", resource)
when { context.taint.sources.contains("web") };`,
  "taint.write-approval": `// Any write made with tainted input parks for approval.
@id("taint.write-approval")
@decision("require_approval")
forbid (principal, action, resource)
when { context.taint.tainted && context.tool.side_effect != "read" }
unless { context.approval.granted };`,
  "taint.recipients": `// A call with tainted input may not send anything outside aintel.
@id("taint.recipients")
forbid (principal, action, resource)
when {
  context.taint.tainted &&
  context.args has recipient_domain &&
  !["aintel.com", "aintel.example"].contains(context.args.recipient_domain)
};`,
  "pii.no-write": `// A support tool may not write a customer's contact fields.
@id("pii.no-write")
forbid (principal, action == Action::"zendesk__update_ticket", resource)
when {
  context.args has fields &&
  context.args.fields.containsAny(["email", "phone", "address"])
};`,
  "warehouse.raw-pii": `// A warehouse query may not read the raw_pii schema.
@id("warehouse.raw-pii")
forbid (principal, action == Action::"snowflake__run_query", resource)
when { context.args has schema && context.args.schema == "raw_pii" };`,
  "pr.own-org": `// A pull request may target only a repository in aintel.
@id("pr.own-org")
forbid (principal, action == Action::"github__create_pull_request", resource)
unless { context.args has repository && context.args.repository like "aintel/*" };`,
  "workflows.approval": `// A change to a CI workflow file parks for approval.
@id("workflows.approval")
@decision("require_approval")
forbid (
  principal,
  action in [Action::"builtin__write_file", Action::"github__create_pull_request"],
  resource
)
when { context.args has path && context.args.path like ".github/workflows/*" }
unless { context.approval.granted };`,
  "docs-writer.docs-only": `// The docs writer edits files under docs/ and nowhere else.
@id("docs-writer.docs-only")
forbid (
  principal == Agent::"aintel.core.docs-writer",
  action == Action::"builtin__write_file",
  resource
)
unless { context.args has path && context.args.path like "docs/*" };`,
  "branch.read-before-delete": `// A branch delete needs a read of the same branch earlier in the run.
@id("branch.read-before-delete")
forbid (principal, action == Action::"github__delete_branch", resource)
unless {
  context.args has branch &&
  context.run.prior_reads.contains(context.args.branch)
};`,
  "mobile.release-branch": `// A release of aintel/mobile is cut only from the release branch.
@id("mobile.release-branch")
forbid (principal, action == Action::"github__create_release", resource)
when { context.args has repository && context.args.repository == "aintel/mobile" }
unless { context.args has branch && context.args.branch == "release" };`,
  "prod.sre": `// A call against prod-east needs an operator with the sre role.
@id("prod.sre")
forbid (principal, action, resource)
when { context.args has cluster && context.args.cluster == "prod-east" }
unless { context.operator.role == "sre" };`,
  "budget.low-read-only": `// A run with less than $1 of budget left may only read.
@id("budget.low-read-only")
forbid (principal, action, resource)
when {
  context.budget.remaining_cents < 100 &&
  context.tool.side_effect != "read"
};`,
  "slack.rate": `// No agent posts to Slack more than 20 times in an hour.
@id("slack.rate")
forbid (principal, action == Action::"slack__post_message", resource)
when { context.rate.calls_last_hour >= 20 };`,
  "tool.version-hold": `// Hold github__create_pull_request@3 until its schema change is reviewed.
@id("tool.version-hold")
forbid (principal, action == Action::"github__create_pull_request", resource)
when { context.tool.version == 3 };`,
  "avoid.no-unless": `@id("avoid.no-unless")
@decision("require_approval")
forbid (principal, action, resource)
when { context.tool.side_effect == "irreversible" };`,
};

/** A spec rule's text. Throws on an id the table lacks, so a typo fails the test. */
export function specRule(id: string): string {
  const text = Object.hasOwn(SPEC_RULES, id) ? SPEC_RULES[id] : undefined;
  if (text === undefined) throw new Error(`No spec rule has the id ${id}.`);
  return text;
}

export interface TestCompile {
  workspace?: string;
  /** Each policy file's text by its path in the steering repo. */
  policies: Readonly<Record<string, string>>;
  agents?: readonly AgentDeclaration[];
  tools?: Readonly<Record<string, CedarToolEntry>>;
}

/** Compiles the set, or throws with every error the compile found. */
export function compileOrThrow(runtime: CedarRuntime, input: TestCompile): CompiledPolicySet {
  const result = compilePolicies(
    {
      workspace: input.workspace ?? CORE,
      policies: Object.entries(input.policies).map(([path, text]) => ({ path, text })),
      agents: input.agents ?? CORE_AGENTS,
      tools: input.tools ?? SPEC_TOOLS,
    },
    runtime,
  );
  if (result.policy_set === undefined) {
    const lines = result.errors.map((e) =>
      [e.path, e.policy_id, e.message].filter((part) => part !== undefined).join(": "),
    );
    throw new Error(`The policy set did not compile.\n${lines.join("\n")}`);
  }
  return result.policy_set;
}
