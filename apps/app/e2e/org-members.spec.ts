/**
 * org-members.spec.ts — e2e proof for the org Members / People surface.
 *
 * Two scenarios:
 *   1. A genuinely fresh org (free tier = 1 seat, already consumed by the
 *      creator — see packages/billing/src/seats.ts getOrgSeatUsage, which
 *      defaults `licenses` to 1 with no active/trialing subscription row)
 *      shows the real seat-limited state: roster with the creator as owner,
 *      the seat-limit warning banner, and the Add Member dialog's real
 *      "no licenses available" gate (Send disabled). This is the org's
 *      honest out-of-the-box state, not a contrived error path.
 *   2. After seeding an active 5-seat subscription (seedSubscription — stands
 *      in for the Stripe webhook, same helper billing-credits-purchase.spec.ts
 *      uses), the full invite pipeline is exercised: invite → the Invited
 *      tab's live count badge → pending list → revoke → gone.
 *
 * NOTE ON SCOPE (read before reusing this as a role-change/remove proof):
 * role-change and remove-member UI (RoleSelector / RemoveMemberDialog in
 * members-panel.tsx) only render for OTHER members — `canManage && !isSelf`
 * gates them off for the viewer's own row. A freshly signed-up org has
 * exactly one member (the creator), and adding a second REAL member requires
 * accepting an invite from a second session, which is out of scope per the
 * task brief. This spec does NOT exercise change_member_role / remove_org_member
 * UI interactions — it proves the roster, the invite pipeline, and that the
 * Add Member control itself is role-gated to owner/admin.
 *
 * Proves: add_org_member / invite pipeline (capability-ui-map). Does NOT
 * prove: change_member_role, remove_org_member UI (see note above).
 */

import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { signUpFreshUser } from "./helpers/signup";
import { seedSubscription } from "./helpers/seed-subscription";
import { gotoStable } from "./helpers/nav";

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))
    return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5432/oxagen",
);

async function getOrgId(orgSlug: string): Promise<string> {
  const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
  try {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM org.organizations WHERE slug = ${orgSlug}
    `;
    if (!row) throw new Error(`org-members: org not found for slug ${orgSlug}`);
    return row.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fresh-org roster + the real seat-limit gate
// ─────────────────────────────────────────────────────────────────────────────

test("org members: fresh-org roster, seat banner, and the real seat-limit gate", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { orgSlug, email } = await signUpFreshUser(page, {
    orgPrefix: "e2e-mem1",
  });

  await gotoStable(page, `/${orgSlug}/members`);
  await expect(page).not.toHaveURL(/\/login/);

  await expect(
    page.getByRole("heading", { name: "Members", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });

  // Roster: the creator, as owner. The read-only role badge (rather than the
  // RoleSelector) proves the self-row correctly suppresses mutating controls.
  await expect(page.getByText(email).first()).toBeVisible();
  await expect(page.getByText("owner", { exact: true })).toBeVisible();

  // Seat usage banner — free tier, 1 license, already consumed by the creator.
  // Filtered: Next's route announcer is a second, permanent role="alert"
  // (#__next-route-announcer__), so the bare role locator is never unique.
  const seatAlert = page
    .getByRole("alert")
    .filter({ hasText: "You have 1 user license" });
  await expect(seatAlert).toBeVisible();

  // Role-gated control: "Add member" is visible because the viewer is owner.
  const addMemberButton = page.getByRole("button", { name: "Add member" });
  await expect(addMemberButton).toBeVisible();

  await addMemberButton.click();
  const dialog = page.getByRole("dialog", { name: "Invite a member" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("No licenses available")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Send invitation" }),
  ).toBeDisabled();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Invite → pending list with live badge → revoke
// ─────────────────────────────────────────────────────────────────────────────

test("org members: invite → pending list with live badge → revoke", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "e2e-mem2" });
  const orgId = await getOrgId(orgSlug);
  const { cleanup } = await seedSubscription({ orgId, seatCount: 5 });
  const inviteeEmail = `e2e-invitee+${Date.now()}@oxagen.test`;

  try {
    await gotoStable(page, `/${orgSlug}/members`);
    await expect(page).not.toHaveURL(/\/login/);

    await page.getByRole("button", { name: "Add member" }).click();
    const dialog = page.getByRole("dialog", { name: "Invite a member" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    await dialog.getByLabel("Email address").fill(inviteeEmail);
    await dialog.getByLabel("Role").click();
    await page.getByRole("option", { name: "Admin" }).click();
    await dialog.getByRole("button", { name: "Send invitation" }).click();

    await expect(page.getByText("Invitation sent")).toBeVisible({
      timeout: 10_000,
    });
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // The Invited tab's live count badge reflects the new pending invitation.
    const invitedTab = page.getByRole("tab", { name: /Invited/i });
    await expect(invitedTab).toBeVisible();
    await expect(invitedTab.getByText("1", { exact: true })).toBeVisible();

    await invitedTab.click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/members/pending`));

    // .first(): the "Invitation sent" toast still carries the email while the
    // pending row appears, so the bare text locator matches both.
    await expect(page.getByText(inviteeEmail).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Admin", { exact: true })).toBeVisible();

    const revokeButton = page.getByRole("button", {
      name: `Revoke invitation for ${inviteeEmail}`,
    });
    await revokeButton.click();

    await expect(page.getByText("Invitation revoked")).toBeVisible({
      timeout: 10_000,
    });
    // The Pending page itself must refresh — declineInvitationAction now
    // revalidates BOTH /members and /members/pending (see actions.ts fix);
    // previously it only revalidated /members, so a Revoke performed from
    // this page never removed the row until an unrelated navigation.
    await expect(page.getByText(inviteeEmail)).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByText("No pending invitations")).toBeVisible();
  } finally {
    await cleanup();
  }
});
