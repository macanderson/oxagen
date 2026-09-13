// @vitest-environment jsdom
/**
 * connection-create-inline.test.tsx
 *
 * Render + interaction tests for ConnectionCreateInline:
 *   - GitHub variant renders title and Connect GitHub button
 *   - Clicking Connect GitHub button opens the wizard (open=true)
 *   - Non-github variant renders sources link with correct href
 *   - Non-github variant shows "Inline connect is not available" copy
 *   - Default connectorId is "github" (no prop → github card shown)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

// Mock the wizard — we just want to verify it receives open=true when button
// is clicked; we don't want to boot the full wizard in unit tests.
vi.mock("@/components/knowledge/connections/github-connection-wizard", () => ({
  GitHubConnectionWizard: ({
    open,
    orgSlug,
    workspaceSlug,
  }: {
    open: boolean;
    onClose: () => void;
    orgSlug: string;
    workspaceSlug: string;
  }) => (
    <div
      data-testid="github-wizard-mock"
      data-open={open ? "true" : "false"}
      data-org={orgSlug}
      data-ws={workspaceSlug}
    />
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    "data-testid": dataTestid,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: string;
    "data-testid"?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      data-testid={dataTestid}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    "data-testid": dataTestid,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    "data-testid"?: string;
    className?: string;
  }) => (
    <a href={href} data-testid={dataTestid} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    GithubIcon: vi.fn(() => <span data-testid="icon-github" />),
    Link: vi.fn(() => <span data-testid="icon-link" />),
  };
});

describe("ConnectionCreateInline — github variant", () => {
  it("renders the GitHub card title", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(
      <ConnectionCreateInline
        connectorId="github"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(screen.getByText("Connect a GitHub repository")).toBeInTheDocument();
  });

  it("renders the Connect GitHub button", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(
      <ConnectionCreateInline
        connectorId="github"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeInTheDocument();
  });

  it("wizard starts closed", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(
      <ConnectionCreateInline
        connectorId="github"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(screen.getByTestId("github-wizard-mock")).toHaveAttribute(
      "data-open",
      "false",
    );
  });

  it("clicking the button opens the wizard (open=true)", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(
      <ConnectionCreateInline
        connectorId="github"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Connect GitHub" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("github-wizard-mock")).toHaveAttribute(
        "data-open",
        "true",
      );
    });
  });

  it("passes orgSlug and workspaceSlug to the wizard", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(
      <ConnectionCreateInline
        connectorId="github"
        orgSlug="my-org"
        workspaceSlug="my-ws"
      />,
    );
    const wizard = screen.getByTestId("github-wizard-mock");
    expect(wizard).toHaveAttribute("data-org", "my-org");
    expect(wizard).toHaveAttribute("data-ws", "my-ws");
  });
});

describe("ConnectionCreateInline — default connectorId", () => {
  it("defaults to github variant when connectorId is omitted", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(<ConnectionCreateInline orgSlug="acme" workspaceSlug="main" />);
    // GitHub card title present means github variant was rendered
    expect(screen.getByText("Connect a GitHub repository")).toBeInTheDocument();
  });
});

describe("ConnectionCreateInline — non-github fallback", () => {
  it("renders 'Connect a source' heading for unknown connectors", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(
      <ConnectionCreateInline
        connectorId="salesforce"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(screen.getByText("Connect a source")).toBeInTheDocument();
  });

  it("renders copy saying inline connect is not available", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(
      <ConnectionCreateInline
        connectorId="salesforce"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(
      screen.getByText(
        /Inline connect is not available for this connector yet/,
      ),
    ).toBeInTheDocument();
  });

  it("renders 'Open Sources' link with correct href", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(
      <ConnectionCreateInline
        connectorId="salesforce"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    const link = screen.getByTestId("connection-create-inline-sources-link");
    expect(link).toHaveAttribute("href", "/acme/main/knowledge/sources");
    expect(link).toHaveTextContent("Open Sources");
  });

  it("falls back to href='/' when orgSlug and workspaceSlug are absent", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(<ConnectionCreateInline connectorId="salesforce" />);
    expect(
      screen.getByTestId("connection-create-inline-sources-link"),
    ).toHaveAttribute("href", "/");
  });

  it("falls back to href='/' when only one slug is present", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(<ConnectionCreateInline connectorId="salesforce" orgSlug="acme" />);
    expect(
      screen.getByTestId("connection-create-inline-sources-link"),
    ).toHaveAttribute("href", "/");
  });

  it("fallback does not render the GitHub wizard", async () => {
    const { default: ConnectionCreateInline } = await import(
      "./connection-create-inline"
    );
    render(
      <ConnectionCreateInline
        connectorId="slack"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(screen.queryByTestId("github-wizard-mock")).not.toBeInTheDocument();
  });
});
