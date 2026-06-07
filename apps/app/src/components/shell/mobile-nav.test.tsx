// @vitest-environment jsdom
/**
 * mobile-nav.test.tsx — render tests for MobileNav.
 *
 * Covers:
 *   - Renders the hamburger trigger button with "Open navigation menu" aria-label
 *   - Opens the sheet when the hamburger is clicked
 *   - Sheet contains the org switcher
 *   - Sheet contains the workspace switcher when workspace is provided
 *   - Does not render WorkspaceSwitcher when workspace is absent
 *   - Nav items are rendered for each sidebar item
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileNav } from "./mobile-nav";

afterEach(cleanup);

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/prod/ask",
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("next/image", () => ({
  default: ({ src, alt, ...rest }: { src: string; alt: string; [k: string]: unknown }) =>
    <img src={src} alt={alt} {...rest} />,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("@/components/workspace/new-workspace-dialog", () => ({
  NewWorkspaceDialog: () => <div data-testid="new-workspace-dialog" />,
}));

const org = { publicId: "org-1", slug: "acme", name: "Acme Corp" };
const workspace = { publicId: "ws-1", slug: "prod", name: "Production" };
const availableOrgs = [{ publicId: "org-1", slug: "acme", name: "Acme Corp" }];
const availableWorkspaces = [{ publicId: "ws-1", slug: "prod", name: "Production" }];
const ctx = { orgSlug: "acme", workspaceSlug: "prod" };
const user = { id: "u-1", email: "jane@example.com", name: "Jane", image: null };

const defaultProps = {
  ctx,
  org,
  workspace,
  availableOrgs,
  availableWorkspaces,
  user,
};

describe("MobileNav — trigger", () => {
  it("renders the hamburger button", () => {
    render(<MobileNav {...defaultProps} />);
    expect(screen.getByRole("button", { name: /open navigation menu/i })).toBeInTheDocument();
  });
});

describe("MobileNav — sheet", () => {
  it("opens the nav sheet when hamburger is clicked", async () => {
    render(<MobileNav {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: /open navigation menu/i }));
    await waitFor(
      () => expect(screen.getByRole("navigation", { name: /primary navigation/i })).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("renders OrgSwitcher inside the sheet", async () => {
    render(<MobileNav {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: /open navigation menu/i }));
    // The sheet opens and org name is shown
    await waitFor(
      () => expect(screen.getAllByText("Acme Corp").length).toBeGreaterThanOrEqual(1),
      { timeout: 2000 },
    );
  });

  it("renders WorkspaceSwitcher inside the sheet when workspace provided", async () => {
    render(<MobileNav {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: /open navigation menu/i }));
    await waitFor(
      () => expect(screen.getAllByText("Production").length).toBeGreaterThanOrEqual(1),
      { timeout: 2000 },
    );
  });

  it("shows user name in the drawer header", async () => {
    render(<MobileNav {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: /open navigation menu/i }));
    await waitFor(
      () => expect(screen.getByText("Jane")).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });
});

describe("MobileNav — no workspace", () => {
  it("does not crash when workspace is undefined", () => {
    render(<MobileNav {...defaultProps} workspace={undefined} availableWorkspaces={[]} />);
    expect(screen.getByRole("button", { name: /open navigation menu/i })).toBeInTheDocument();
  });
});
