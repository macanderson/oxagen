// @vitest-environment jsdom
// Organization › Model funding, the section around the form: what it shows
// for each answer the `get_model_credential` read can give. A key stored, no
// key, a viewer below Owner or Admin, and a read that failed each render
// their own state, and the tabs stay in every one of them.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCredential } from "@/data/contracts/org";
import { type Read, readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/acme/model-funding",
}));
vi.mock("./model-funding-actions", () => ({
  testModelKey: vi.fn(),
  saveModelKey: vi.fn(),
  removeModelKey: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { orgSource } = await import("./organization.builders");
const { ModelFunding } = await import("./model-funding");
const { needsBaseUrl, needsModelMap, MODEL_PROVIDERS } = await import(
  "./model-funding-rules"
);

const STORED: ModelCredential = {
  configured: true,
  provider: "openrouter",
  status: "active",
  keyHint: "wxyz",
  baseUrl: null,
  modelMap: {},
  lastVerifiedAt: null,
  rotatedAt: "2026-09-18T11:00:00.000Z",
};

// The section is rendered the way the page renders it: the async server
// component asks the data source for the one read it needs and hands the
// answer to the section. Rendering it this way also proves the read is the
// org-scoped `modelCredential` and nothing else.
async function renderSection(read: Read<ModelCredential>) {
  const ctx = unsafeMint(OrgCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole: "owner",
  });
  const { source, calls } = orgSource({ modelCredential: read });
  const view = render(
    <IntlProvider>{await ModelFunding({ ctx, source })}</IntlProvider>,
  );
  expect(calls.modelCredential).toEqual([[ctx]]);
  return view;
}

afterEach(cleanup);

describe("ModelFunding", () => {
  it("shows the stored key and the form to replace it", async () => {
    await renderSection({ ok: true, value: STORED });
    expect(screen.getByTestId("funding-current").textContent).toContain(
      "OpenRouter",
    );
    expect(screen.getByTestId("funding-form")).toBeTruthy();
  });

  it("offers the Model funding tab as the current one", async () => {
    await renderSection({ ok: true, value: STORED });
    const tab = screen.getByRole("link", { name: "Model funding and routes" });
    expect(tab.getAttribute("aria-current")).toBe("page");
  });

  it("says only an owner or admin can see this, rather than a form every write would refuse", async () => {
    await renderSection({
      ok: false,
      reason: "denied",
      permission: "get_model_credential",
    });
    expect(screen.getByTestId("funding-denied")).toBeTruthy();
    expect(screen.queryByTestId("funding-form")).toBeNull();
  });

  it("replaces only the section body when the read fails", async () => {
    await renderSection(readError("kernel_failure", 503));
    expect(screen.queryByTestId("funding-form")).toBeNull();
    // The tabs survive a failed read.
    expect(screen.getByRole("link", { name: "Model funding and routes" })).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { container } = await renderSection({ ok: true, value: STORED });
    await expectNoAxe(container);
  });
});

describe("model-funding rules mirror the contract", () => {
  it("agrees with the contract on which vendors need a URL and which need models", async () => {
    const shared = await import(
      "@oxagen/oxagen/contracts/org.model_credential.shared"
    );
    expect([...MODEL_PROVIDERS].sort()).toEqual(
      [...shared.modelCredentialProviderSchema.options].sort(),
    );
    for (const provider of MODEL_PROVIDERS) {
      expect(needsBaseUrl(provider)).toBe(
        shared.requiresCustomerBaseUrl(provider),
      );
      expect(needsModelMap(provider)).toBe(shared.requiresModelMap(provider));
    }
  });
});
