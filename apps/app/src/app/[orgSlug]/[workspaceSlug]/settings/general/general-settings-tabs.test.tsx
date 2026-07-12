// @vitest-environment jsdom
/**
 * general-settings-tabs.test.tsx — component tests for GeneralSettingsTabs.
 *
 * Covers:
 *   (a) Renders both tabs ("General", "Members") and the initial panel content.
 *   (b) initialTab="members" renders the Members panel first.
 *   (c) Clicking "Members" switches the visible panel and calls router.replace
 *       with `?tab=members`, `{ scroll: false }`.
 *   (d) Clicking back to "General" calls router.replace with the bare pathname
 *       (no query param — "general" is the default tab).
 */

import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

const { mockReplace } = vi.hoisted(() => ({ mockReplace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/acme/prod/settings/general",
}));

import { GeneralSettingsTabs } from "./general-settings-tabs";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GeneralSettingsTabs", () => {
  it("renders both sub-tabs and the General panel by default", () => {
    render(
      <GeneralSettingsTabs
        initialTab="general"
        generalPanel={<p>General form content</p>}
        membersPanel={<p>Members list content</p>}
      />,
    );
    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Members" })).toBeInTheDocument();
    expect(screen.getByText("General form content")).toBeInTheDocument();
  });

  it("renders the Members panel first when initialTab is 'members'", () => {
    render(
      <GeneralSettingsTabs
        initialTab="members"
        generalPanel={<p>General form content</p>}
        membersPanel={<p>Members list content</p>}
      />,
    );
    expect(screen.getByText("Members list content")).toBeInTheDocument();
  });

  it("switches to the Members panel and updates the URL with ?tab=members", async () => {
    render(
      <GeneralSettingsTabs
        initialTab="general"
        generalPanel={<p>General form content</p>}
        membersPanel={<p>Members list content</p>}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Members" }));

    expect(screen.getByText("Members list content")).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith(
      "/acme/prod/settings/general?tab=members",
      { scroll: false },
    );
  });

  it("switching back to General updates the URL with no query param", async () => {
    render(
      <GeneralSettingsTabs
        initialTab="members"
        generalPanel={<p>General form content</p>}
        membersPanel={<p>Members list content</p>}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "General" }));

    expect(screen.getByText("General form content")).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith("/acme/prod/settings/general", {
      scroll: false,
    });
  });
});
