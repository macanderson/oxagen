// @vitest-environment jsdom
// The approvals drawer's selected card (audit-prompt checks 7 and 26): the
// same card Fleet and Run draw, alone. No panel heading, so the drawer keeps
// one "Approvals" heading and no second `fleet-approvals` id reaches a page
// that already carries Fleet's own; no parked count; no two-column grid, so
// the card takes the drawer's full width; and the decision is still there.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalItem } from "@/data/contracts/approvals";
import { IntlProvider } from "@/test/intl";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("./actions", () => ({
  resolveApprovalAction: vi.fn(),
  readApprovalEligibility: vi.fn(),
}));

const { ApprovalCardAlone } = await import("./approvals-panel");

const item: ApprovalItem = {
  id: "apr_01K5RS8F3J",
  runId: "run_01K5RS7M2E",
  tool: "github__create_release@2",
  agentKey: "acme.core.release-manager",
  requester: "usr_01K3F8QB7R",
  mandateId: null,
  rule: "role_grant:rg_0093",
  autoEligibility: null,
  createdAt: "2026-09-23T09:24:20Z",
  expiresAt: "2026-09-23T09:40:20Z",
};

afterEach(cleanup);

describe("ApprovalCardAlone", () => {
  it("draws one card with its chain and decision, and no panel heading, count or grid", () => {
    render(
      <IntlProvider>
        <ApprovalCardAlone
          item={item}
          mandates={new Map()}
          now={Date.parse("2026-09-23T09:30:00Z")}
          org="acme"
          ws="core-platform"
        />
      </IntlProvider>,
    );
    const list = screen.getByTestId("approval-card-alone");
    expect(within(list).getAllByTestId("approval")).toHaveLength(1);
    expect(within(list).getByTestId("chain")).toHaveTextContent(
      "acme.core.release-manager",
    );
    // The decision is the same control Fleet and Run draw.
    expect(within(list).getByTestId("decide")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.getElementById("fleet-approvals")).toBeNull();
    expect(list.className).not.toMatch(/grid-cols-2/);
  });
});
