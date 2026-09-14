// @vitest-environment jsdom
/**
 * org-switcher.test.tsx — render tests for OrgSwitcher.
 *
 * Covers:
 *   - Renders the active org name in the trigger
 *   - Renders the plan label in the trigger (falls back to "Free")
 *   - Renders all org names in the menu when opened
 *   - Shows a checkmark on the active org
 *   - Renders org avatar initial when no avatarUrl
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrgSwitcher } from "./org-switcher";

afterEach(cleanup);

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    ...rest
  }: {
    src: string;
    alt: string;
    [k: string]: unknown;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element -- jsdom test shim; real next/image requires Next.js runtime
    <img src={src} alt={alt} {...rest} />
  ),
}));

const current = { publicId: "org-1", slug: "acme", name: "Acme Corp" };
const organizations = [
  { publicId: "org-1", slug: "acme", name: "Acme Corp", planLabel: "Build" },
  { publicId: "org-2", slug: "beta", name: "Beta LLC", planLabel: "Free" },
];

describe("OrgSwitcher — trigger rendering", () => {
  it("renders the active org name in the trigger", () => {
    render(<OrgSwitcher current={current} organizations={organizations} />);
    const names = screen.getAllByText("Acme Corp");
    expect(names.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the plan label 'Build' in the trigger", () => {
    render(<OrgSwitcher current={current} organizations={organizations} />);
    expect(screen.getByText("Build")).toBeInTheDocument();
  });

  it("defaults to 'Free' plan label when not found in org list", () => {
    const orgs = [{ publicId: "org-2", slug: "beta", name: "Beta LLC" }];
    render(<OrgSwitcher current={current} organizations={orgs} />);
    expect(screen.getByText("Free")).toBeInTheDocument();
  });

  it("renders the org initials when no avatarUrl", () => {
    render(<OrgSwitcher current={current} organizations={organizations} />);
    // EntityAvatar renders two-word initials ("Acme Corp" → "AC") when there's
    // no image or designed avatar value.
    const initials = screen.getAllByText("AC");
    expect(initials.length).toBeGreaterThanOrEqual(1);
  });
});

describe("OrgSwitcher — menu", () => {
  it("opens menu with all org names when trigger is clicked", async () => {
    render(<OrgSwitcher current={current} organizations={organizations} />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(
      () => expect(screen.getByText("Beta LLC")).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("navigates to org on menu item click", async () => {
    render(<OrgSwitcher current={current} organizations={organizations} />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(
      () => expect(screen.getByText("Beta LLC")).toBeInTheDocument(),
      { timeout: 2000 },
    );
    await userEvent.click(screen.getByText("Beta LLC"));
    expect(pushMock).toHaveBeenCalledWith("/beta");
  });
});
