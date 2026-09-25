/**
 * INV-27 and INV-28 (apps/app/ARCHITECTURE.md §1.5, §4): which rev1 invokes
 * the billing gate and the recorder see.
 *
 * The kernel bills every top-level, scoped, non-`noBillingGate` invoke that
 * carries an orgId. ADR-052 exclusion 2 says reading your own spend, settings
 * or membership is never a charge, so every console read the app binds and
 * every rev1 write except `resolve_approval` declares `noBillingGate: true`.
 * `resolve_approval` is the one governed action.
 *
 * Both lists are read from the registry by name, so a contract renamed or
 * unregistered fails here rather than silently leaving the list. The INV-27
 * list is complete for the billing page: WL-27, WL-28, WL-29 and WL-30 have
 * all landed (`get_gau_bucket`, `purchase_gau_bucket`, `list_invoices`,
 * `set_auto_topup`), and WL-67 adds the second meter's `purchase_credits`.
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import "./index";

/** INV-27: the billing-page reads and the billing writes that buy or change plan. */
const BILLING_PAGE_CONTRACTS = [
  "get_subscription",
  "get_contract_rate",
  "get_gau_bucket",
  "purchase_gau_bucket",
  "list_invoices",
  "set_auto_topup",
  // WL-67, the second meter (§3.9): the in-app AI usage credit top-up. A
  // prepaid org whose GAU bucket is empty must still be able to buy credits.
  "purchase_credits",
  // Change plan on the Billing page (#3309). A prepaid org at remaining = 0
  // is the one that needs to upgrade; without the flag the kernel refused it.
  "start_subscription_upgrade",
  // Statements on the Billing page (ADR-165). A finance team reconciling a
  // month at remaining = 0 is exactly the reader who needs one.
  "get_billing_statement",
  "export_billing_statement",
  // ADR-165: the org's prepaid orders. An enterprise whose bucket is empty
  // must still be able to read what it prepaid and whether it was granted.
  "list_prepaid_orders",
] as const;

/** INV-28: the §1.5 list — every rev1 invoke that is not a governed action. */
const CONSOLE_CONTRACTS = [
  "list_runs",
  "get_run",
  "list_approvals",
  "list_members",
  "list_api_keys",
  "list_orgs",
  "list_workspaces",
  "create_api_key",
  "revoke_api_key",
  // `dispatch_tacho_command` until this lane renamed it, with no alias
  // (ADR-025). `list_commands` is the delivery report beside it and is a
  // console read by the same argument, so it belongs on this list too.
  "dispatch_command",
  "list_commands",
  "authorize_cli",
  "change_member_role",
  "remove_org_member",
  "accept_member_invite",
  "decline_member_invite",
  // The #2964 lane: the roles read and the role and workspace settings
  // writes the Organization page binds (ADR-052 exclusion 2).
  "list_iam_roles",
  "create_role",
  "set_role_grants",
  "delete_role",
  "create_workspace",
  "update_workspace_settings",
  "archive_workspace",
  // The shell's reads and its one settings write (#2968): the engine probe,
  // the reply a dropped stream left on the record (ADR-176), the command
  // menu, the sidebar counts, the account preferences.
  "get_assistant_engine",
  "get_assistant_reply",
  "search_tools",
  "load_tools",
  "get_nav_counts",
  "list_recent_runs",
  "list_notifications",
  "mark_notification",
  "set_preferences",
  // The #2962 lane: the Spend page's reads, its ceiling write and its
  // statement export (ADR-052 exclusion 2: reading and capping your own spend).
  "get_spend",
  "get_spend_drill",
  "list_waste",
  "get_spend_budget",
  "set_spend_budget",
  "export_statement",
  // The Audit page (#3097): reading and exporting the organization's own
  // record. An audit trail that goes dark when the balance does is not one.
  "query_audit_log",
  "export_audit_events",
  // The #3098 lane: the Skills page's one read (ADR-052 exclusion 2).
  "list_skills",
] as const;

/** The one rev1 governed action. */
const GOVERNED_ACTION = "resolve_approval";

function flagOf(name: string): boolean | undefined {
  const cap = getCapability(name);
  expect(cap, `${name} is a registered contract`).toBeDefined();
  return cap?.noBillingGate;
}

describe("INV-27 — reading your bill and buying more are never refused for lack of GAUs", () => {
  it.each(BILLING_PAGE_CONTRACTS)("%s declares noBillingGate: true", (name) => {
    expect(flagOf(name)).toBe(true);
  });
});

describe("INV-28 — no console read is a governed action", () => {
  it.each(CONSOLE_CONTRACTS)("%s declares noBillingGate: true", (name) => {
    expect(flagOf(name)).toBe(true);
  });

  it(`${GOVERNED_ACTION} does not declare the flag: it is the governed action`, () => {
    expect(flagOf(GOVERNED_ACTION)).not.toBe(true);
  });

  it("ask_assistant declares the flag: the turn is free to the customer (#2968 decision 3), and each tool call inside it is its own governed action (kernel.usage-recorder.test.ts)", () => {
    expect(flagOf("ask_assistant")).toBe(true);
  });

  it("the lists and the governed action are disjoint", () => {
    const all: string[] = [...BILLING_PAGE_CONTRACTS, ...CONSOLE_CONTRACTS];
    expect(all).not.toContain(GOVERNED_ACTION);
    expect(new Set(all).size).toBe(all.length);
  });
});
