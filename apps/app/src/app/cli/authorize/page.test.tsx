// @vitest-environment jsdom
// /cli/authorize names itself pages.cliAuthorize in the tab and the h1 whatever
// the query holds (ARCHITECTURE.md §1.2): a query that is not a valid PKCE set
// renders the refusal without reaching sign-in; a valid one reaches consent.
import { createHash } from "node:crypto";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Read } from "@/data/read";
import { translator } from "@/test/intl";
import { expectPageTitle, renderPage, routeProps } from "@/test/render-page";

type Choices = Read<{ slug: string }[]>;
const { loadConsentChoices, redirectTo, requireUser } = vi.hoisted(() => ({
  loadConsentChoices: vi.fn<() => Promise<Choices>>(),
  redirectTo: vi.fn<(path: string) => void>(),
  requireUser: vi.fn<(next: string) => Promise<unknown>>(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("@/server/viewer", () => ({ requireUser }));
vi.mock("@/data/source", () => ({ dataSource: () => ({}) }));
vi.mock("@/shared/navigation", () => ({ redirectTo }));
vi.mock("@/features/auth", async () => ({
  ...(await vi.importActual<typeof import("@/features/auth/cli-authorize")>(
    "@/features/auth/cli-authorize",
  )),
  loadConsentChoices,
  CliConsentForm: () => <form data-testid="cli-consent" />,
}));

const page = await import("./page");
const title = translator("pages")("cliAuthorize");

/** A valid loopback PKCE set, as `oxagen auth login` sends it. */
const PKCE = {
  redirect_uri: "http://127.0.0.1:53682/callback",
  state: "st_4f1c",
  code_challenge: createHash("sha256")
    .update("verifier-for-the-page-test-0123456789abcdef")
    .digest("base64url"),
  code_challenge_method: "S256",
  label: "laptop",
};

beforeEach(() => {
  for (const mock of [loadConsentChoices, redirectTo, requireUser])
    mock.mockReset();
  requireUser.mockResolvedValue({});
  loadConsentChoices.mockResolvedValue({
    ok: true,
    value: [{ slug: "a-intel" }],
  });
});

describe("/cli/authorize", () => {
  it("without a valid PKCE query: the refusal under the page title, and no sign-in (negative)", async () => {
    await expectPageTitle(
      page,
      routeProps({}, { ...PKCE, redirect_uri: "https://evil.example/cb" }),
      title,
    );
    expect(screen.getByTestId("cli-invalid")).toBeInTheDocument();
    expect(requireUser).not.toHaveBeenCalled();
  });

  it("with a valid PKCE query: consent under the page title for a signed-in person", async () => {
    await expectPageTitle(page, routeProps({}, PKCE), title);
    expect(requireUser).toHaveBeenCalledWith(
      expect.stringMatching(/^\/cli\/authorize\?/),
    );
    expect(screen.getByTestId("cli-consent")).toBeInTheDocument();
  });

  it("with a valid PKCE query and an unreadable organization list: the failure under the page title (negative)", async () => {
    loadConsentChoices.mockResolvedValue({
      ok: false,
      reason: "error",
      code: "shell_unavailable",
      status: 503,
    });
    await expectPageTitle(page, routeProps({}, PKCE), title);
    expect(screen.getByTestId("cli-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("cli-consent")).toBeNull();
  });

  it("with a valid PKCE query and no organization yet: sends the account to create one and back", async () => {
    loadConsentChoices.mockResolvedValue({ ok: true, value: [] });
    await renderPage(page.default(routeProps({}, PKCE)));
    expect(redirectTo).toHaveBeenCalledWith(
      expect.stringMatching(/^\/new-organization\?next=%2Fcli%2Fauthorize%3F/),
    );
  });
});
