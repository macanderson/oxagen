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
 * list grows with WL-27…WL-30 (`get_gau_bucket`, `list_invoices`,
 * `purchase_gau_bucket`, `set_auto_topup`).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import "./index";

/** INV-27: a billing-page read and the two billing writes. */
const BILLING_PAGE_CONTRACTS = [
  "get_subscription",
  "get_contract_rate",
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
  "dispatch_tacho_command",
  "authorize_cli",
  "change_member_role",
  "remove_org_member",
  "accept_member_invite",
  "decline_member_invite",
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

  it("the lists and the governed action are disjoint", () => {
    const all: string[] = [...BILLING_PAGE_CONTRACTS, ...CONSOLE_CONTRACTS];
    expect(all).not.toContain(GOVERNED_ACTION);
    expect(new Set(all).size).toBe(all.length);
  });
});
