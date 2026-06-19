/**
 * Knowledge → Sources: edit config + delete a source connection.
 *
 * Exercises the two affordances added to each source row's "⋯" menu:
 *   1. Edit configuration — opens a sheet pre-filled from the connection's
 *      stored deliveryConfig (connection.get) and the connector manifest
 *      (plugin.schema.get), renames it, and saves via PATCH /connections/:id.
 *   2. Delete source — opens a confirmation with the delete-mode choice and
 *      fires DELETE /connections/:id?mode=full (delete connection + all stamped
 *      graph nodes & edges).
 *
 * A connection is seeded through the same authenticated app→API proxy the UI
 * uses (POST /connections), so the server-rendered list has a real row to act
 * on. The edit round-trip hits the real connection.update handler; the delete
 * is asserted by request shape (the async purge job is out of scope here).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

const SHOTS = "e2e/screenshots";

test("edit config and delete a source from the knowledge sources tab", async ({ page }) => {
  const user = await signUpFreshUser(page);
  const ws = "default";
  const base = `/api/v1/${user.orgSlug}/${ws}/connections`;

  // ── Seed a connection (same credentialed path the wizard uses) ──────────────
  const seedRes = await page.request.post(base, {
    data: {
      connectorId: "github",
      displayName: "Seed Source",
      authCredential: { type: "api_key", apiKey: "ghp_e2e_dummy_token" },
      connectionConfig: { organizations: ["acme"], owner: "acme", repo: "core" },
      deliveryMethod: "webhook",
    },
  });
  expect(
    seedRes.ok(),
    `seed POST /connections → ${seedRes.status()}: ${await seedRes.text().catch(() => "<no body>")}`,
  ).toBe(true);
  const { publicId } = (await seedRes.json()) as { publicId: string };
  expect(publicId).toBeTruthy();

  await page.goto(`/${user.orgSlug}/${ws}/knowledge/sources`);

  // Row + actions menu render.
  await expect(page.getByTestId(`connection-row-${publicId}`)).toBeVisible();

  // ── Edit configuration ──────────────────────────────────────────────────────
  await page.getByTestId(`source-menu-trigger-${publicId}`).click();
  await page.getByTestId(`edit-source-${publicId}`).click();

  await expect(page.getByTestId("edit-source-sheet")).toBeVisible();
  const nameInput = page.getByTestId("edit-source-display-name");
  // Pre-filled from connection.get.
  await expect(nameInput).toHaveValue("Seed Source");
  // Manifest-driven config fields rendered (github → organizations, etc.).
  await expect(page.getByTestId("edit-source-config-fields")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/source-edit-sheet.png` });

  await nameInput.fill("Renamed Source");
  const patchResp = page.waitForResponse(
    (r) => r.url().includes(`/connections/${publicId}`) && r.request().method() === "PATCH",
  );
  await page.getByTestId("save-source-config-btn").click();
  const patchRes = await patchResp;
  expect(
    patchRes.ok(),
    `PATCH /connections → ${patchRes.status()}: ${await patchRes.text().catch(() => "<no body>")}`,
  ).toBe(true);

  // List reflects the new name after router.refresh().
  await expect(page.getByText("Renamed Source")).toBeVisible();

  // ── Delete source ───────────────────────────────────────────────────────────
  await page.getByTestId(`source-menu-trigger-${publicId}`).click();
  await page.getByTestId(`delete-source-${publicId}`).click();

  await expect(page.getByTestId("delete-source-dialog")).toBeVisible();
  await expect(page.getByTestId("delete-mode-full")).toBeVisible();
  await expect(page.getByTestId("delete-mode-connection_only")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/source-delete-dialog.png` });

  const deleteResp = page.waitForResponse(
    (r) => r.url().includes(`/connections/${publicId}`) && r.request().method() === "DELETE",
  );
  await page.getByTestId("confirm-delete-source-btn").click();
  const deleteRes = await deleteResp;
  expect(
    deleteRes.ok(),
    `DELETE /connections → ${deleteRes.status()}: ${await deleteRes.text().catch(() => "<no body>")}`,
  ).toBe(true);
  // Default mode deletes the connection AND its stamped graph nodes/edges.
  expect(new URL(deleteRes.url()).searchParams.get("mode")).toBe("full");
});
