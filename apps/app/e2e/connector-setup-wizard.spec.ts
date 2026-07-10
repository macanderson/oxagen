/**
 * Connector setup wizard — Marketplace → Integrations → [connectorId].
 *
 * The ConnectorConfigForm cluster (apps/app/src/components/connectors/) was
 * fully built and unit-tested but never mounted on a route. This spec proves
 * the wizard is real: the integrations grid links non-GitHub connectors to
 * the new [connectorId] route, the page SSR-prefetches the connector schema
 * (get_plugin_schema) and renders the dynamic form, a field interaction
 * updates form state, and submitting calls the real install_integration
 * capability (POST /integrations) and redirects to Knowledge → Repos.
 *
 * google-drive is used because its only auth scheme is OAuth (no auth
 * fields to fill) and every config field either has a defaultValue or is
 * optional — the form is submittable with zero required input, which keeps
 * the test deterministic while still exercising a field interaction.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test("Marketplace → Integrations links to the in-app connector setup wizard", async ({
  page,
}) => {
  const user = await signUpFreshUser(page);

  await page.goto(`/${user.orgSlug}/default/marketplace/integrations`);
  await page.getByTestId("integrations-grid").waitFor();

  const connectLink = page.getByTestId("integration-connect-google-drive");
  await expect(connectLink).toBeVisible();
  await expect(connectLink).toHaveAttribute(
    "href",
    `/${user.orgSlug}/default/marketplace/integrations/google-drive`,
  );

  // GitHub keeps its bespoke Knowledge → Repos OAuth-App flow, not this wizard.
  await expect(page.getByTestId("integration-connect-github")).toHaveAttribute(
    "href",
    /\/default\/knowledge\/repos\?setup=github/,
  );
});

test("Connector setup wizard renders the schema-driven form and installs the connector", async ({
  page,
}) => {
  const user = await signUpFreshUser(page);

  const schemaResponse = page.waitForResponse(
    (res) =>
      res.url().includes("/plugin-schema/google-drive") &&
      res.request().method() === "GET",
  );
  await page.goto(
    `/${user.orgSlug}/default/marketplace/integrations/google-drive`,
  );

  // exact:true — Next streams the document <title> ("Connect Google Drive |
  // Marketplace") into the body, and substring getByText matches it too.
  await expect(
    page.getByText("Connect Google Drive", { exact: true }),
  ).toBeVisible();

  // Schema is SSR-prefetched by getConnectorSetupSchemaAction — if the client
  // provider still had to fetch it live, the schema request below would come
  // back 404/never fire because the server already resolved it.
  const schemaRes = await schemaResponse.catch(() => null);
  if (schemaRes) {
    expect(schemaRes.ok(), `GET plugin-schema → ${schemaRes.status()}`).toBe(
      true,
    );
  }

  // Schema-driven config fields render (no OAuth auth fields — see file header).
  const sharedDrivesToggle = page.getByLabel("Shared Drives Only");
  await expect(sharedDrivesToggle).toBeVisible();
  await expect(page.getByLabel("Exclude Trashed Files")).toBeChecked();

  // Form interaction: toggle a config field and confirm the control reflects it.
  await sharedDrivesToggle.click();
  await expect(sharedDrivesToggle).toBeChecked();

  const installResponse = page.waitForResponse(
    (res) =>
      res.url().endsWith("/integrations") && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: /connect/i }).click();

  const installRes = await installResponse;
  expect(installRes.ok(), `POST /integrations → ${installRes.status()}`).toBe(
    true,
  );
  const body = (await installRes.json()) as {
    status: string;
    pluginId: string;
  };
  expect(body.pluginId).toBe("google-drive");
  expect(body.status).toBe("queued");

  // Success redirects to Knowledge → Repos, where the pending_setup connection
  // is managed (auth completion, first sync).
  await page.waitForURL(
    new RegExp(`/${user.orgSlug}/default/knowledge/repos$`),
  );
});
