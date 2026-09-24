// @vitest-environment jsdom
// /new-organization names itself pages.newOrganization in the tab; the screen
// draws the gate shell and the form whose h1 carries the same words
// (ARCHITECTURE.md §1.2). The screen's own tests cover what it renders.
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import { expectPageTitle, routeProps } from "@/test/render-page";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("@/features/onboarding", () => ({
  NewOrganizationLoading: () => <div data-testid="page-state-loading" />,
  NewOrganizationScreen: () => (
    <form data-testid="organization-form">
      <h1>{translator("onboarding.organization")("title")}</h1>
    </form>
  ),
}));

describe("/new-organization", () => {
  it("pages.newOrganization is the document title and the form's one h1", async () => {
    await expectPageTitle(
      await import("./page"),
      routeProps({}),
      translator("pages")("newOrganization"),
    );
    expect(screen.getByTestId("organization-form")).toBeInTheDocument();
  });
});
