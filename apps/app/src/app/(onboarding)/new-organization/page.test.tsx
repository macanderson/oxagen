// @vitest-environment jsdom
// /new-organization names itself pages.newOrganization in the tab and the h1
// (ARCHITECTURE.md §1.2); the heading and the gated screen share one boundary.
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import { expectPageTitle, routeProps } from "@/test/render-page";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("@/features/onboarding", () => ({
  NewOrganizationScreen: () => <form data-testid="organization-form" />,
}));

describe("/new-organization", () => {
  it("pages.newOrganization is the document title and the one h1, above the organization form", async () => {
    await expectPageTitle(
      await import("./page"),
      routeProps({}),
      translator("pages")("newOrganization"),
    );
    expect(screen.getByTestId("organization-form")).toBeInTheDocument();
  });
});
