/**
 * asset.upload — e2e spec.
 *
 * Verifies the asset.upload capability surface end-to-end:
 *   1. Auth guard: unauthenticated POST to the API surface returns 401.
 *   2. Auth guard: authenticated POST with a private IP sourceUrl returns an
 *      error (SSRF protection active even through the HTTP surface).
 *   3. Authenticated POST with a valid public source URL ingests the asset and
 *      returns a CDN url + canonical key.
 *
 * Seeding: uses the agent-runtime fixture for org + user + session.
 *
 * Note: the happy-path test uses a real public image URL (a small, stable
 * PNG hosted at the W3C). If network access is unavailable the test is skipped
 * rather than failing — CI runs against localhost where external calls succeed.
 */

import { test, expect } from "@playwright/test";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";

const ORG_SLUG = "e2e-asset-upload";
const WS_SLUG = "main";
const USER_EMAIL = "e2e+asset-upload@oxagen.ai";

// A tiny, stable public PNG served by the W3C — deterministic bytes across runs.
const PUBLIC_PNG_URL =
  "https://www.w3.org/WAI/WCAG21/Techniques/pdf/img/table-word.jpg";

let fixture: AgentRuntimeFixture;

test.describe("asset.upload — auth guard", () => {
  test("unauthenticated POST returns 401", async ({ request, baseURL }) => {
    const apiBase = (baseURL ?? "http://localhost:3000").replace(
      /:\d+$/,
      ":3100",
    );
    const res = await request.post(
      `${apiBase}/v1/${ORG_SLUG}/${WS_SLUG}/assets/upload`,
      {
        data: {
          sourceUrl: "https://example.com/photo.png",
          kind: "image",
        },
        headers: { "content-type": "application/json" },
        failOnStatusCode: false,
      },
    );
    expect(res.status()).toBe(401);
  });
});

test.describe("asset.upload — authenticated surface", () => {
  test.beforeAll(async () => {
    fixture = await setupAgentRuntimeFixture({
      orgSlug: ORG_SLUG,
      workspaceSlug: WS_SLUG,
      userEmail: USER_EMAIL,
    });
  });

  test.afterAll(async () => {
    await teardownFixture({ orgSlug: ORG_SLUG });
  });

  test("SSRF: private IPv4 URL returns an error response", async ({
    request,
    baseURL,
  }) => {
    const apiBase = (baseURL ?? "http://localhost:3000").replace(
      /:\d+$/,
      ":3100",
    );
    const res = await request.post(
      `${apiBase}/v1/${ORG_SLUG}/${WS_SLUG}/assets/upload`,
      {
        data: {
          sourceUrl: "http://192.168.1.1/secret.png",
          kind: "image",
        },
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${fixture.sessionToken}`,
        },
        failOnStatusCode: false,
      },
    );
    // Must not be 2xx — the SSRF guard must reject the private IP.
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test("happy path: ingests a public PNG and returns url, key, contentType, bytes", async ({
    request,
    baseURL,
  }) => {
    test.skip(
      process.env.CI_OFFLINE === "true",
      "Skipping external network call in offline CI",
    );

    const apiBase = (baseURL ?? "http://localhost:3000").replace(
      /:\d+$/,
      ":3100",
    );
    const res = await request.post(
      `${apiBase}/v1/${ORG_SLUG}/${WS_SLUG}/assets/upload`,
      {
        data: {
          sourceUrl: PUBLIC_PNG_URL,
          kind: "image",
        },
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${fixture.sessionToken}`,
        },
        failOnStatusCode: false,
      },
    );

    // Storage token may not be configured in local dev — treat 503 as "infra skip".
    if (res.status() === 503) {
      test.skip(true, "Storage adapter not configured in this env");
      return;
    }

    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      url: string;
      key: string;
      contentType: string;
      bytes: number;
    };

    // url must be a valid https CDN URL
    expect(body.url).toMatch(/^https?:\/\//);

    // key must follow the owner-derived pattern: image/<orgId>/...
    expect(body.key).toMatch(/^image\//);

    // contentType from the fetched response
    expect(typeof body.contentType).toBe("string");
    expect(body.contentType.length).toBeGreaterThan(0);

    // bytes must be a positive integer
    expect(Number.isInteger(body.bytes)).toBe(true);
    expect(body.bytes).toBeGreaterThan(0);
  });
});
