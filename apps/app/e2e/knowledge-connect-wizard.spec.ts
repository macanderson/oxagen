/**
 * Knowledge → Sources → Connect wizard — the new governed multi-step
 * "Connect a source" flow (docs/web-app-2.0/workspace/knowledge/sources/
 * connect/spec.md). Proves the wizard is real end-to-end for a non-OAuth
 * connector: connector picker → schema-driven credentials form → sample
 * preview → LLM-suggested mappings (editable) → confirm + activate →
 * redirect to Knowledge → Sources.
 *
 * "Generic Webhook" (custom-webhook) is used because it is NOT OAuth-only
 * (supportedAuthSchemes: bearer_token, api_key, public — see
 * packages/ingestion/src/connectors/custom-webhook/index.ts) and its
 * "public" auth scheme has zero credential fields, and its
 * previewRecordTypes() is a pure function of the submitted config (no real
 * outbound network call, unlike e.g. custom-sql which would need a live
 * database at the far end of the connection string) — the only connector in
 * the catalog whose Preview step succeeds deterministically without a real
 * external service, which keeps this test reliable in CI.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

test("Connect a source wizard: pick → credentials → preview → mappings → confirm → redirect", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const user = await signUpFreshUser(page);

  await gotoStable(page, `/${user.orgSlug}/default/knowledge/sources/connect`);
  await expect(page.getByText("Connect a source", { exact: true })).toBeVisible();
  await expect(page.getByText("Step 1 of 5")).toBeVisible();

  // Step 1 — pick connector. Generic Webhook is not OAuth-only, so selecting
  // it advances inline instead of rendering the redirect-out notice.
  await page.getByTestId("connector-picker-grid").waitFor();
  await page.getByTestId("connector-select-custom-webhook").click();

  // Step 2 — credentials, schema-driven form (get_plugin_schema SSR/CSR
  // fetch resolves and renders real fields, not a hardcoded form).
  await expect(page.getByText("Step 2 of 5")).toBeVisible();
  await expect(page.getByLabel("Connection name")).toBeVisible({ timeout: 15_000 });

  // Select the "public" auth scheme so no secret/bearer token is required.
  await page.getByRole("radio", { name: /no authentication/i }).click();

  // Required config field: JSON array of record-type definitions
  // (packages/ingestion/src/connectors/custom-webhook/schema.yaml).
  await page
    .getByLabel("Record Type Definitions")
    .fill('[{"sourceRecordType":"webhook_event","eventTypeJsonPath":"$.event","matcher":"*"}]');

  await page.getByTestId("credentials-next-btn").click();

  // Step 3 — preview. custom-webhook's previewRecordTypes() is a pure
  // function of config, so this resolves without any external network call.
  await expect(page.getByText("Step 3 of 5")).toBeVisible({ timeout: 30_000 });

  // Wait for the preview to reach one of its three terminal states before
  // asserting which one, so a failure names the cause instead of a missing
  // testid. preview-step.tsx renders ErrorState ("Couldn't preview this
  // connection") when preview_connection throws and EmptyState ("No records
  // found") when it returns nothing, and both are invisible to an assertion
  // that only looks for the populated card — which is why #1188 could say the
  // record type was absent but not why.
  const populated = page.getByTestId("preview-record-type-webhook_event");
  const previewFailed = page.getByText("Couldn't preview this connection");
  const previewEmpty = page.getByText("No records found");

  await expect(populated.or(previewFailed).or(previewEmpty).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(previewFailed, "preview_connection threw").toHaveCount(0);
  await expect(
    previewEmpty,
    "preview_connection returned no record types for the declared config",
  ).toHaveCount(0);
  await expect(populated).toBeVisible();
  await page.getByTestId("preview-next-btn").click();

  // Step 4 — mappings, LLM-suggested and editable. Real suggest_connection_mappings
  // call — give it a generous timeout.
  await expect(page.getByText("Step 4 of 5")).toBeVisible();

  // Same treatment as the preview step above, for the same reason. This step
  // has four terminal states (mappings-step.tsx): the draft rows, a loading
  // placeholder, ErrorState ("Couldn't generate mapping suggestions") when the
  // model call fails, and EmptyState ("No mappings to review") when it returns
  // nothing. Waiting only for a row cannot tell a slow call from a failed one
  // from an empty one, and #1188 spent a long time not knowing which.
  const mappingRow = page.getByTestId("mapping-row-webhook_event");
  const mappingsFailed = page.getByText("Couldn't generate mapping suggestions");
  const mappingsEmpty = page.getByText("No mappings to review");

  await expect(mappingRow.or(mappingsFailed).or(mappingsEmpty).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    mappingsFailed,
    "suggest_connection_mappings failed — read the description for the provider error",
  ).toHaveCount(0);
  await expect(
    mappingsEmpty,
    "suggest_connection_mappings returned no drafts for webhook_event (fieldSchema is {} for custom-webhook)",
  ).toHaveCount(0);
  await expect(mappingRow).toBeVisible();
  const entityTypeInput = page.getByLabel("Entity type");
  await expect(entityTypeInput).not.toHaveValue("");
  // The suggestion is editable — prove it, not just displayed.
  await entityTypeInput.fill("webhook_event");
  await page.getByTestId("mappings-next-btn").click();

  // Step 5 — confirm + activate.
  await expect(page.getByText("Step 5 of 5")).toBeVisible();
  await expect(page.getByTestId("confirm-mapping-summary")).toContainText("webhook_event");
  await page.getByTestId("confirm-activate-btn").click();

  // set_connection_mappings persists + activates, then redirects to Sources
  // with the new connection visible.
  await page.waitForURL(new RegExp(`/${user.orgSlug}/default/knowledge/sources$`), { timeout: 30_000 });

  // The Sources page's ConnectionsSection (RSC) invokes list_connections to
  // render the list — the freshly created connection's row appearing here is
  // the runtime proof for the list_connections UI binding
  // (capability-ui-map.json → list_connections.proof points at this spec).
  await expect(
    page.locator('[data-testid^="connection-row-"]').first(),
  ).toBeVisible({ timeout: 15_000 });
});

test("Connect a source wizard: OAuth-only connectors render a redirect-out notice instead of an inline form", async ({
  page,
}) => {
  const user = await signUpFreshUser(page);

  await gotoStable(page, `/${user.orgSlug}/default/knowledge/sources/connect`);
  await page.getByTestId("connector-picker-grid").waitFor();

  await page.getByTestId("connector-select-google-drive").click();
  await expect(page.getByTestId("oauth-redirect-notice")).toBeVisible();
  await expect(page.getByTestId("oauth-redirect-link")).toHaveAttribute(
    "href",
    `/${user.orgSlug}/default/marketplace/integrations/google-drive`,
  );
  // Still on Step 1 — selecting an OAuth-only connector must not silently
  // advance the wizard into a dead credentials form.
  await expect(page.getByText("Step 1 of 5")).toBeVisible();
});
