import { beforeAll, describe, expect, it } from "vitest";
import {
  evaluateHookCall,
  requireCedarRuntime,
  type CedarDecision,
  type CedarRuntime,
} from "@oxagen/tacho/policy";
import { hostCedarBundle, type AgentDeclaration, type CompiledPolicySet } from "./compile";
import { decideToolCall, type ToolCallInput } from "./evaluate";
import {
  CI_REVIEWER,
  CORE,
  CORE_AGENTS,
  COST_ANALYST,
  DOCS_WRITER,
  FINOPS,
  INVOICE_BOT,
  NOW,
  RELEASE_BOT,
  RELEASE_MANAGER,
  STELLA_CI,
  TRIAGE,
  compileOrThrow,
  specRule,
} from "./testing";

let runtime: CedarRuntime;

beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

/** Saturday 2026-09-26 at 11:00 UTC. */
const SATURDAY_11 = Date.UTC(2026, 8, 26, 11);
/** Tuesday 2026-09-22 at 18:00 UTC, after business hours. */
const TUESDAY_18 = Date.UTC(2026, 8, 22, 18);

type HostBundle = NonNullable<ReturnType<typeof hostCedarBundle>>;

type Call = Omit<ToolCallInput, "runtime" | "policy" | "agent" | "now"> & { now?: number };

function specSet(rules: readonly string[], workspace = CORE, agents = CORE_AGENTS): CompiledPolicySet {
  return compileOrThrow(runtime, {
    workspace,
    agents,
    policies: { "policy/spec.cedar": rules.map(specRule).join("\n\n") },
  });
}

function decide(policy: CompiledPolicySet, agent: AgentDeclaration, call: Call) {
  return decideToolCall({ runtime, policy, agent: agent.name, now: NOW, ...call });
}

const SHELL_RULE = `// Only the release bot runs shell commands.
forbid (principal, action == Action::"builtin__shell", resource)
unless { principal == Agent::"aintel.core.release-bot" };`;

describe("the shell rule on every harness", () => {
  let policy: CompiledPolicySet;
  beforeAll(() => {
    policy = compileOrThrow(runtime, { policies: { "policy/shell.cedar": SHELL_RULE } });
  });

  it.each([
    ["Claude Code's Bash", DOCS_WRITER, "Bash"],
    ["Codex's shell", CI_REVIEWER, "shell"],
    ["Codex's exec_command", RELEASE_MANAGER, "exec_command"],
    ["Cursor's Shell", TRIAGE, "Shell"],
    ["Stella's bash", STELLA_CI, "bash"],
    ["a tool Claude Code's map lacks", DOCS_WRITER, "NotebookRun"],
  ])("denies builtin__shell for %s", (_label, agent, harnessTool) => {
    const verdict = decide(policy, agent, { harness_tool: harnessTool, args: { command: "ls" } });
    expect(verdict).toMatchObject({
      decision: "deny",
      action: "builtin__shell",
      agent: agent.name,
      reasons: ["policy/shell.cedar#1"],
      errors: [],
    });
  });

  it("allows builtin__shell for the release bot", () => {
    const verdict = decide(policy, RELEASE_BOT, { harness_tool: "Bash", args: { command: "ls" } });
    expect(verdict).toMatchObject({
      decision: "allow",
      action: "builtin__shell",
      reasons: ["grant.builtin.claude-code"],
    });
  });

  it("decides a call named by its action the same way", () => {
    expect(decide(policy, CI_REVIEWER, { action: "builtin__shell" }).decision).toBe("deny");
    expect(decide(policy, RELEASE_BOT, { action: "builtin__shell" }).decision).toBe("allow");
  });

  it("gives the hook on each host the gateway's decision", () => {
    const ci = hostCedarBundle(policy, "ci-linux-01");
    const laptop = hostCedarBundle(policy, "laptop-7");
    if (ci === undefined || laptop === undefined) throw new Error("Both hosts run an agent.");
    const hook = (cedar: HostBundle, harness: string, toolName: string) =>
      evaluateHookCall({ runtime, cedar, harness, toolName, toolInput: { command: "ls" }, now: NOW });

    expect(hook(ci, "codex", "shell")).toMatchObject({
      decision: "deny",
      action: "builtin__shell",
      principals: [CI_REVIEWER.name, RELEASE_MANAGER.name],
      reasons: ["policy/shell.cedar#1"],
    });
    expect(hook(ci, "claude-code", "Bash")).toMatchObject({
      decision: "allow",
      principals: [RELEASE_BOT.name],
      reasons: ["grant.builtin.claude-code"],
    });
    expect(hook(ci, "stella", "bash")).toMatchObject({ decision: "deny", principals: [STELLA_CI.name] });
    expect(hook(laptop, "claude-code", "Bash")).toMatchObject({
      decision: "deny",
      principals: [DOCS_WRITER.name],
    });
    expect(hook(laptop, "cursor", "Shell")).toMatchObject({ decision: "deny", principals: [TRIAGE.name] });
  });
});

describe("approval rules", () => {
  it("parks a call when every rule that denies it is an approval rule", () => {
    const policy = specSet(["irreversible.approval", "refund.over-500"], FINOPS, [INVOICE_BOT]);
    expect(policy.approval_ids).toEqual(["irreversible.approval", "refund.over-500"]);
    const verdict = decide(policy, INVOICE_BOT, {
      action: "stripe__create_refund",
      args: { amount_cents: 72_000 },
    });
    expect(verdict).toMatchObject({
      decision: "require_approval",
      reasons: ["irreversible.approval", "refund.over-500"],
      errors: [],
    });
  });

  it("denies when one rule that denies is not an approval rule", () => {
    const policy = specSet(
      ["irreversible.approval", "refund.over-500", "money.business-hours"],
      FINOPS,
      [INVOICE_BOT],
    );
    const verdict = decide(policy, INVOICE_BOT, {
      action: "stripe__create_refund",
      args: { amount_cents: 72_000 },
      now: SATURDAY_11,
    });
    expect(verdict).toMatchObject({
      decision: "deny",
      reasons: ["irreversible.approval", "money.business-hours", "refund.over-500"],
    });
  });

  it("allows the call once the approval is granted", () => {
    const policy = specSet(["irreversible.approval", "refund.over-500"], FINOPS, [INVOICE_BOT]);
    const verdict = decide(policy, INVOICE_BOT, {
      action: "stripe__create_refund",
      args: { amount_cents: 72_000 },
      approval: { granted: true, approvers: 1 },
    });
    expect(verdict.decision).toBe("allow");
  });
});

interface SpecRow {
  name: string;
  rules: string[];
  agent: AgentDeclaration;
  call: Call;
  decision: CedarDecision;
  reasons: string[];
  workspace?: string;
  agents?: readonly AgentDeclaration[];
}

const APPROVED = { granted: true, approvers: 1 };
const TAINTED = { tainted: true, sources: ["web"] };
const FINOPS_ONLY = { workspace: FINOPS, agents: [INVOICE_BOT] };

const SPEC_ROWS: SpecRow[] = [
  {
    name: "reads.open allows a low-risk read",
    rules: ["reads.open"],
    agent: TRIAGE,
    call: { action: "kubernetes__get_logs", args: { pod: "api-7" } },
    decision: "allow",
    reasons: ["grant.tools.1", "reads.open"],
  },
  {
    name: "reads.high-risk-routed denies a high-risk read on the harness tier",
    rules: ["reads.high-risk-routed"],
    agent: STELLA_CI,
    call: { action: "snowflake__run_query", args: { sql: "select 1" }, tier: "harness" },
    decision: "deny",
    reasons: ["reads.high-risk-routed"],
  },
  {
    name: "reads.high-risk-routed allows the read through the gateway",
    rules: ["reads.high-risk-routed"],
    agent: STELLA_CI,
    call: { action: "snowflake__run_query", args: { sql: "select 1" }, tier: "gateway" },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "irreversible.approval parks an irreversible call",
    rules: ["irreversible.approval"],
    agent: RELEASE_MANAGER,
    call: { action: "github__create_release", args: { repository: "aintel/api", branch: "main" } },
    decision: "require_approval",
    reasons: ["irreversible.approval"],
  },
  {
    name: "irreversible.approval allows it once approved",
    rules: ["irreversible.approval"],
    agent: RELEASE_MANAGER,
    call: {
      action: "github__create_release",
      args: { repository: "aintel/api", branch: "main" },
      approval: APPROVED,
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "slack.external-approval allows an internal channel",
    rules: ["slack.external-approval"],
    agent: RELEASE_BOT,
    call: { action: "slack__post_message", args: { channel: "releases", text: "v3 is out" } },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "slack.external-approval parks a shared external channel",
    rules: ["slack.external-approval"],
    agent: RELEASE_BOT,
    call: { action: "slack__post_message", args: { channel: "ext-acme", text: "v3 is out" } },
    decision: "require_approval",
    reasons: ["slack.external-approval"],
  },
  {
    name: "payments.two-approvers parks a large payment with one approver",
    rules: ["payments.two-approvers"],
    ...FINOPS_ONLY,
    agent: INVOICE_BOT,
    call: {
      action: "stripe__create_payment",
      args: { amount_cents: 245_000, counterparty: "vendor:aws" },
      approval: APPROVED,
    },
    decision: "require_approval",
    reasons: ["payments.two-approvers"],
  },
  {
    name: "payments.two-approvers allows it with two approvers",
    rules: ["payments.two-approvers"],
    ...FINOPS_ONLY,
    agent: INVOICE_BOT,
    call: {
      action: "stripe__create_payment",
      args: { amount_cents: 245_000, counterparty: "vendor:aws" },
      approval: { granted: true, approvers: 2 },
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "payments.two-approvers allows a payment under the limit",
    rules: ["payments.two-approvers"],
    ...FINOPS_ONLY,
    agent: INVOICE_BOT,
    call: { action: "stripe__create_payment", args: { amount_cents: 64_000, counterparty: "vendor:aws" } },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "repo.delete-never denies beside an approval rule",
    rules: ["repo.delete-never", "irreversible.approval"],
    agent: RELEASE_MANAGER,
    call: { action: "github__delete_repository", args: { repository: "aintel/old" } },
    decision: "deny",
    reasons: ["irreversible.approval", "repo.delete-never"],
  },
  {
    name: "repo.delete-never denies even with an approval",
    rules: ["repo.delete-never", "irreversible.approval"],
    agent: RELEASE_MANAGER,
    call: { action: "github__delete_repository", args: { repository: "aintel/old" }, approval: APPROVED },
    decision: "deny",
    reasons: ["repo.delete-never"],
  },
  {
    name: "refund.over-500 allows a small refund",
    rules: ["refund.over-500"],
    agent: RELEASE_MANAGER,
    call: { action: "stripe__create_refund", args: { amount_cents: 12_000 } },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "refund.over-500 parks a large refund",
    rules: ["refund.over-500"],
    agent: RELEASE_MANAGER,
    call: { action: "stripe__create_refund", args: { amount_cents: 72_000 } },
    decision: "require_approval",
    reasons: ["refund.over-500"],
  },
  {
    name: "payment.vendor-list allows a listed vendor",
    rules: ["payment.vendor-list"],
    agent: RELEASE_MANAGER,
    call: { action: "stripe__create_payment", args: { amount_cents: 500, counterparty: "vendor:aws" } },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "payment.vendor-list denies an unlisted counterparty",
    rules: ["payment.vendor-list"],
    agent: RELEASE_MANAGER,
    call: { action: "stripe__create_payment", args: { amount_cents: 500, counterparty: "acct:unknown" } },
    decision: "deny",
    reasons: ["payment.vendor-list"],
  },
  {
    name: "payment.quote-first allows a payment the run priced",
    rules: ["payment.quote-first"],
    agent: RELEASE_MANAGER,
    call: {
      action: "stripe__create_payment",
      args: { amount_cents: 500, counterparty: "vendor:aws" },
      run: { prior_calls: ["stripe__list_prices"], prior_reads: [] },
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "payment.quote-first denies a payment with no price lookup",
    rules: ["payment.quote-first"],
    agent: RELEASE_MANAGER,
    call: { action: "stripe__create_payment", args: { amount_cents: 500, counterparty: "vendor:aws" } },
    decision: "deny",
    reasons: ["payment.quote-first"],
  },
  {
    name: "money.business-hours allows a refund on a weekday morning",
    rules: ["money.business-hours"],
    agent: RELEASE_MANAGER,
    call: { action: "stripe__create_refund", args: { amount_cents: 1_000 } },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "money.business-hours denies a refund on Saturday",
    rules: ["money.business-hours"],
    agent: RELEASE_MANAGER,
    call: { action: "stripe__create_refund", args: { amount_cents: 1_000 }, now: SATURDAY_11 },
    decision: "deny",
    reasons: ["money.business-hours"],
  },
  {
    name: "money.business-hours denies a refund after 17:00",
    rules: ["money.business-hours"],
    agent: RELEASE_MANAGER,
    call: { action: "stripe__create_refund", args: { amount_cents: 1_000 }, now: TUESDAY_18 },
    decision: "deny",
    reasons: ["money.business-hours"],
  },
  {
    name: "mandate.remaining allows a payment the mandate covers",
    rules: ["mandate.remaining"],
    agent: RELEASE_MANAGER,
    call: {
      action: "stripe__create_payment",
      args: { amount_cents: 20_000, counterparty: "vendor:aws" },
      mandate_remaining_cents: 25_000,
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "mandate.remaining denies a payment larger than the mandate",
    rules: ["mandate.remaining"],
    agent: RELEASE_MANAGER,
    call: {
      action: "stripe__create_payment",
      args: { amount_cents: 90_000, counterparty: "vendor:aws" },
      mandate_remaining_cents: 25_000,
    },
    decision: "deny",
    reasons: ["mandate.remaining"],
  },
  {
    name: "mandate.remaining leaves a call with no mandate to the other rules",
    rules: ["mandate.remaining"],
    agent: RELEASE_MANAGER,
    call: { action: "stripe__create_payment", args: { amount_cents: 90_000, counterparty: "vendor:aws" } },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "spend.finops-only allows an agent in finops",
    rules: ["spend.finops-only"],
    ...FINOPS_ONLY,
    agent: INVOICE_BOT,
    call: { action: "aws_billing__purchase_savings_plan" },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "spend.finops-only denies an agent in another workspace",
    rules: ["spend.finops-only"],
    agent: COST_ANALYST,
    call: { action: "aws_billing__purchase_savings_plan" },
    decision: "deny",
    reasons: ["spend.finops-only"],
  },
  {
    name: "taint.shell allows an untainted shell command",
    rules: ["taint.shell"],
    agent: STELLA_CI,
    call: { harness_tool: "bash", args: { command: "make test" } },
    decision: "allow",
    reasons: ["grant.builtin.stella"],
  },
  {
    name: "taint.shell denies a shell command after a web fetch",
    rules: ["taint.shell"],
    agent: STELLA_CI,
    call: { harness_tool: "bash", args: { command: "make test" }, taint: TAINTED },
    decision: "deny",
    reasons: ["taint.shell"],
  },
  {
    name: "taint.write-approval allows an untainted write",
    rules: ["taint.write-approval"],
    agent: TRIAGE,
    call: { action: "linear__update_issue", args: { issue: "OX-12" } },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "taint.write-approval parks a tainted write",
    rules: ["taint.write-approval"],
    agent: TRIAGE,
    call: { action: "linear__update_issue", args: { issue: "OX-12" }, taint: TAINTED },
    decision: "require_approval",
    reasons: ["taint.write-approval"],
  },
  {
    name: "taint.recipients allows a tainted upload inside aintel",
    rules: ["taint.recipients"],
    agent: TRIAGE,
    call: {
      action: "slack__upload_file",
      args: { channel: "support", recipient_domain: "aintel.com" },
      taint: TAINTED,
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "taint.recipients denies a tainted upload outside aintel",
    rules: ["taint.recipients"],
    agent: TRIAGE,
    call: {
      action: "slack__upload_file",
      args: { channel: "support", recipient_domain: "partner.io" },
      taint: TAINTED,
    },
    decision: "deny",
    reasons: ["taint.recipients"],
  },
  {
    name: "pii.no-write allows a ticket update without contact fields",
    rules: ["pii.no-write"],
    agent: TRIAGE,
    call: { action: "zendesk__update_ticket", args: { fields: ["status", "priority"] } },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "pii.no-write denies a write to a contact field",
    rules: ["pii.no-write"],
    agent: TRIAGE,
    call: { action: "zendesk__update_ticket", args: { fields: ["status", "email"] } },
    decision: "deny",
    reasons: ["pii.no-write"],
  },
  {
    name: "warehouse.raw-pii allows another schema",
    rules: ["warehouse.raw-pii"],
    agent: COST_ANALYST,
    call: { action: "snowflake__run_query", args: { schema: "analytics", sql: "select 1" } },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "warehouse.raw-pii denies the raw_pii schema",
    rules: ["warehouse.raw-pii"],
    agent: COST_ANALYST,
    call: { action: "snowflake__run_query", args: { schema: "raw_pii", sql: "select 1" } },
    decision: "deny",
    reasons: ["warehouse.raw-pii"],
  },
  {
    name: "pr.own-org allows a pull request in aintel",
    rules: ["pr.own-org"],
    agent: CI_REVIEWER,
    call: {
      action: "github__create_pull_request",
      args: { repository: "aintel/platform", path: "src/a.ts", head: "fix/a" },
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "pr.own-org denies a pull request elsewhere",
    rules: ["pr.own-org"],
    agent: CI_REVIEWER,
    call: {
      action: "github__create_pull_request",
      args: { repository: "octo/fork", path: "src/a.ts", head: "fix/a" },
    },
    decision: "deny",
    reasons: ["pr.own-org"],
  },
  {
    name: "workflows.approval allows an edit outside the workflows",
    rules: ["workflows.approval"],
    agent: STELLA_CI,
    call: { harness_tool: "edit_file", args: { path: "src/index.ts" } },
    decision: "allow",
    reasons: ["grant.builtin.stella"],
  },
  {
    name: "workflows.approval parks an edit to a workflow",
    rules: ["workflows.approval"],
    agent: STELLA_CI,
    call: { harness_tool: "edit_file", args: { path: ".github/workflows/ci.yml" } },
    decision: "require_approval",
    reasons: ["workflows.approval"],
  },
  {
    name: "docs-writer.docs-only allows an edit under docs",
    rules: ["docs-writer.docs-only"],
    agent: DOCS_WRITER,
    call: { harness_tool: "Edit", args: { file_path: "docs/policy.md" } },
    decision: "allow",
    reasons: ["grant.builtin.claude-code"],
  },
  {
    name: "docs-writer.docs-only denies an edit to source",
    rules: ["docs-writer.docs-only"],
    agent: DOCS_WRITER,
    call: { harness_tool: "Edit", args: { file_path: "src/index.ts" } },
    decision: "deny",
    reasons: ["docs-writer.docs-only"],
  },
  {
    name: "docs-writer.docs-only leaves another agent alone",
    rules: ["docs-writer.docs-only"],
    agent: RELEASE_BOT,
    call: { harness_tool: "Edit", args: { file_path: "src/index.ts" } },
    decision: "allow",
    reasons: ["grant.builtin.claude-code"],
  },
  {
    name: "branch.read-before-delete allows a delete after a read",
    rules: ["branch.read-before-delete"],
    agent: RELEASE_BOT,
    call: {
      action: "github__delete_branch",
      args: { branch: "fix/old" },
      run: { prior_calls: ["github__get_branch"], prior_reads: ["fix/old"] },
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "branch.read-before-delete denies a delete with no read",
    rules: ["branch.read-before-delete"],
    agent: RELEASE_BOT,
    call: { action: "github__delete_branch", args: { branch: "fix/old" } },
    decision: "deny",
    reasons: ["branch.read-before-delete"],
  },
  {
    name: "mobile.release-branch allows a release from the release branch",
    rules: ["mobile.release-branch"],
    agent: RELEASE_MANAGER,
    call: { action: "github__create_release", args: { repository: "aintel/mobile", branch: "release" } },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "mobile.release-branch denies a release from main",
    rules: ["mobile.release-branch"],
    agent: RELEASE_MANAGER,
    call: { action: "github__create_release", args: { repository: "aintel/mobile", branch: "main" } },
    decision: "deny",
    reasons: ["mobile.release-branch"],
  },
  {
    name: "prod.sre denies a developer beside an approval rule",
    rules: ["prod.sre", "irreversible.approval"],
    agent: RELEASE_MANAGER,
    call: { action: "kubernetes__delete_pod", args: { cluster: "prod-east", pod: "api-7" } },
    decision: "deny",
    reasons: ["irreversible.approval", "prod.sre"],
  },
  {
    name: "prod.sre leaves an sre to the approval rule",
    rules: ["prod.sre", "irreversible.approval"],
    agent: RELEASE_MANAGER,
    call: {
      action: "kubernetes__delete_pod",
      args: { cluster: "prod-east", pod: "api-7" },
      operator_role: "sre",
    },
    decision: "require_approval",
    reasons: ["irreversible.approval"],
  },
  {
    name: "prod.sre allows an sre with an approval",
    rules: ["prod.sre", "irreversible.approval"],
    agent: RELEASE_MANAGER,
    call: {
      action: "kubernetes__delete_pod",
      args: { cluster: "prod-east", pod: "api-7" },
      operator_role: "sre",
      approval: APPROVED,
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "budget.low-read-only allows a write with budget left",
    rules: ["budget.low-read-only"],
    agent: TRIAGE,
    call: { action: "linear__update_issue", args: { issue: "OX-12" }, budget_remaining_cents: 1_200 },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "budget.low-read-only denies a write under $1",
    rules: ["budget.low-read-only"],
    agent: TRIAGE,
    call: { action: "linear__update_issue", args: { issue: "OX-12" }, budget_remaining_cents: 40 },
    decision: "deny",
    reasons: ["budget.low-read-only"],
  },
  {
    name: "budget.low-read-only allows a read under $1",
    rules: ["budget.low-read-only"],
    agent: TRIAGE,
    call: {
      action: "github__get_file_contents",
      args: { repository: "aintel/api", path: "README.md" },
      budget_remaining_cents: 40,
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "slack.rate allows the 20th post in an hour",
    rules: ["slack.rate"],
    agent: RELEASE_BOT,
    call: {
      action: "slack__post_message",
      args: { channel: "releases", text: "v3" },
      rate: { calls_last_hour: 19, calls_last_minute: 1 },
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "slack.rate denies the 21st",
    rules: ["slack.rate"],
    agent: RELEASE_BOT,
    call: {
      action: "slack__post_message",
      args: { channel: "releases", text: "v3" },
      rate: { calls_last_hour: 20, calls_last_minute: 1 },
    },
    decision: "deny",
    reasons: ["slack.rate"],
  },
  {
    name: "tool.version-hold denies the held version",
    rules: ["tool.version-hold"],
    agent: CI_REVIEWER,
    call: {
      action: "github__create_pull_request",
      args: { repository: "aintel/api", path: "a.ts", head: "fix/a" },
    },
    decision: "deny",
    reasons: ["tool.version-hold"],
  },
  {
    name: "tool.version-hold allows another version",
    rules: ["tool.version-hold"],
    agent: CI_REVIEWER,
    call: {
      action: "github__create_pull_request",
      args: { repository: "aintel/api", path: "a.ts", head: "fix/a" },
      version: 4,
    },
    decision: "allow",
    reasons: ["grant.tools.1"],
  },
  {
    name: "avoid.no-unless parks a call even after its approval",
    rules: ["avoid.no-unless"],
    agent: RELEASE_MANAGER,
    call: {
      action: "github__create_release",
      args: { repository: "aintel/api", branch: "main" },
      approval: APPROVED,
    },
    decision: "require_approval",
    reasons: ["avoid.no-unless"],
  },
];

describe("the agent policy spec's examples", () => {
  it.each(SPEC_ROWS)("$name", (row) => {
    const policy = specSet(row.rules, row.workspace, row.agents);
    const verdict = decide(policy, row.agent, row.call);
    expect(verdict.errors).toEqual([]);
    expect(verdict.decision).toBe(row.decision);
    expect(verdict.reasons).toEqual(row.reasons);
  });
});

describe("calls that cannot be decided", () => {
  let policy: CompiledPolicySet;
  beforeAll(() => {
    policy = specSet(["refund.over-500"]);
  });

  it("denies an agent the workspace does not declare", () => {
    const verdict = decideToolCall({
      runtime,
      policy,
      agent: "aintel.core.nobody",
      action: "stripe__create_refund",
      now: NOW,
    });
    expect(verdict).toEqual({
      decision: "deny",
      reasons: [],
      errors: ["The workspace declares no agent named aintel.core.nobody."],
      action: "stripe__create_refund",
      agent: "aintel.core.nobody",
    });
  });

  it("denies a tool the workspace did not import", () => {
    const verdict = decide(policy, RELEASE_BOT, { action: "jira__create_issue" });
    expect(verdict).toMatchObject({
      decision: "deny",
      action: "jira__create_issue",
      errors: ["The workspace imported no tool named jira__create_issue."],
    });
  });

  it("denies a call that names no tool", () => {
    const verdict = decide(policy, RELEASE_BOT, {});
    expect(verdict).toMatchObject({ decision: "deny", action: "", errors: ["The call names no tool."] });
  });

  it("denies an argument of the wrong type", () => {
    const verdict = decide(policy, RELEASE_BOT, {
      action: "stripe__create_refund",
      args: { amount_cents: "72000" },
    });
    expect(verdict).toMatchObject({
      decision: "deny",
      action: "stripe__create_refund",
      errors: ["Argument amount_cents is not a Long."],
    });
  });

  it("denies a built-in argument of the wrong type", () => {
    const verdict = decide(policy, RELEASE_BOT, { action: "builtin__shell", args: { command: 7 } });
    expect(verdict).toMatchObject({ decision: "deny", errors: ["Argument command is not a String."] });
  });

  it("denies a call whose context the schema rejects", () => {
    const verdict = decide(policy, RELEASE_BOT, {
      action: "builtin__shell",
      args: { command: "ls" },
      taint: { tainted: "yes", sources: [] } as unknown as ToolCallInput["taint"],
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reasons).toEqual([]);
    expect(verdict.errors.length).toBeGreaterThan(0);
  });

  it("ignores an argument the tool does not declare", () => {
    const verdict = decide(policy, RELEASE_BOT, {
      action: "stripe__create_refund",
      args: { amount_cents: 1_000, memo: "thanks" },
    });
    expect(verdict).toMatchObject({ decision: "allow", errors: [] });
  });
});

describe("skills", () => {
  const REVIEW_RULE = `// The code reviewer skill only reads.
forbid (principal, action, resource)
when {
  context has skill &&
  context.skill == "aintel.platform.code-reviewer" &&
  context.tool.side_effect != "read"
};`;
  const SKILL = "aintel.platform.code-reviewer";
  let policy: CompiledPolicySet;
  beforeAll(() => {
    policy = compileOrThrow(runtime, { policies: { "policy/review.cedar": REVIEW_RULE } });
  });

  it("denies a write the skill's rule forbids on Claude Code", () => {
    const verdict = decide(policy, DOCS_WRITER, {
      harness_tool: "Write",
      args: { file_path: "docs/a.md" },
      skill: SKILL,
    });
    expect(verdict).toMatchObject({ decision: "deny", reasons: ["policy/review.cedar#1"] });
  });

  it("allows the skill a read", () => {
    const verdict = decide(policy, DOCS_WRITER, {
      harness_tool: "Read",
      args: { file_path: "docs/a.md" },
      skill: SKILL,
    });
    expect(verdict).toMatchObject({ decision: "allow", action: "builtin__read_file" });
  });

  it.each([
    ["Codex", CI_REVIEWER, "apply_patch", { input: "*** Begin Patch\n*** Update File: a.ts\n*** End Patch" }],
    ["Cursor", TRIAGE, "Write", { file_path: "a.ts" }],
    ["Stella", STELLA_CI, "edit_file", { path: "a.ts" }],
  ])("drops the skill on %s, which does not name one", (_label, agent, harnessTool, args) => {
    const verdict = decide(policy, agent, { harness_tool: harnessTool, args, skill: SKILL });
    expect(verdict).toMatchObject({ decision: "allow", action: "builtin__write_file" });
  });
});

describe("argument sets and declarations", () => {
  it("decides a patch once per file and keeps the strictest verdict", () => {
    const policy = specSet(["workflows.approval"]);
    const patch = [
      "*** Begin Patch",
      "*** Update File: docs/a.md",
      "@@",
      "-old",
      "+new",
      "*** Update File: .github/workflows/ci.yml",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const verdict = decide(policy, CI_REVIEWER, { harness_tool: "apply_patch", args: { input: patch } });
    expect(verdict).toMatchObject({
      decision: "require_approval",
      action: "builtin__write_file",
      reasons: ["workflows.approval"],
    });
  });

  it("reads the operator's role and the budget from the agent's declaration", () => {
    const oncall: AgentDeclaration = {
      name: "aintel.core.oncall",
      operator: "priya",
      runtime: "ci-linux-01",
      harness: "codex",
      operator_role: "sre",
      budget_remaining_cents: 40,
    };
    const policy = specSet(["prod.sre", "budget.low-read-only"], CORE, [...CORE_AGENTS, oncall]);
    const call = { action: "kubernetes__delete_pod", args: { cluster: "prod-east", pod: "api-7" } };

    expect(decide(policy, oncall, call)).toMatchObject({
      decision: "deny",
      reasons: ["budget.low-read-only"],
    });
    expect(decide(policy, oncall, { ...call, budget_remaining_cents: 5_000 })).toMatchObject({
      decision: "allow",
    });
    expect(
      decide(policy, oncall, { ...call, budget_remaining_cents: 5_000, operator_role: "developer" }),
    ).toMatchObject({ decision: "deny", reasons: ["prod.sre"] });
  });
});
