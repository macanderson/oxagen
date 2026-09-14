// @vitest-environment jsdom
/**
 * user-switcher.test.tsx — render tests for UserSwitcher.
 *
 * Covers:
 *   - Renders nothing when user is undefined
 *   - Full variant: shows display name and email
 *   - Full variant: shows initials when no image
 *   - Initials computation (two words, single word, email fallback)
 *   - Trigger aria-label contains the display name
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { UserSwitcher, type SessionUser } from "./user-switcher";

afterEach(cleanup);

// Mock dependencies
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@oxagen/auth/client", () => ({
  signOut: vi.fn().mockResolvedValue({}),
}));

vi.mock("@oxagen/ui", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    ...rest
  }: {
    src: string;
    alt: string;
    [key: string]: unknown;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element -- jsdom test shim; real next/image requires Next.js runtime
    <img src={src} alt={alt} {...rest} />
  ),
}));

const user: SessionUser = {
  id: "u1",
  name: "Jane Smith",
  email: "jane@example.com",
  image: null,
};

describe("UserSwitcher — renders nothing when user is undefined", () => {
  it("returns null for undefined user", () => {
    const { container } = render(<UserSwitcher user={undefined} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("UserSwitcher — full variant", () => {
  it("renders display name", () => {
    render(<UserSwitcher user={user} />);
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
  });

  it("renders email (at least once in trigger)", () => {
    render(<UserSwitcher user={user} />);
    // Email appears in the trigger AND the menu header; getAllByText handles both
    const els = screen.getAllByText("jane@example.com");
    expect(els.length).toBeGreaterThanOrEqual(1);
  });

  it("shows initials 'JS' for 'Jane Smith'", () => {
    render(<UserSwitcher user={user} />);
    // Initials appear in the trigger avatar; may also appear in menu avatar
    const els = screen.getAllByText("JS");
    expect(els.length).toBeGreaterThanOrEqual(1);
  });

  it("trigger has aria-label mentioning the display name", () => {
    render(<UserSwitcher user={user} />);
    expect(
      screen.getByRole("button", { name: /open account menu for jane smith/i }),
    ).toBeInTheDocument();
  });
});

describe("UserSwitcher — initials logic", () => {
  it("shows first letter of single name", () => {
    render(<UserSwitcher user={{ ...user, name: "Alice" }} />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("falls back to first letter of email when name is null", () => {
    render(<UserSwitcher user={{ ...user, name: null }} />);
    // email = jane@example.com → first char 'J'
    expect(screen.getByText("J")).toBeInTheDocument();
  });

  it("avatar variant: renders the initials in the avatar", () => {
    render(<UserSwitcher user={user} variant="avatar" />);
    // Initials still render in avatar mode
    const els = screen.getAllByText("JS");
    expect(els.length).toBeGreaterThanOrEqual(1);
  });
});

describe("UserSwitcher — with image", () => {
  it("renders an img element when user.image is set", () => {
    render(
      <UserSwitcher
        user={{ ...user, image: "https://example.com/avatar.png" }}
      />,
    );
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "https://example.com/avatar.png");
  });
});
