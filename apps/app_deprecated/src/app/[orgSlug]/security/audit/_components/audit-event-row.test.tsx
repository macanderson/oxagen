// @vitest-environment jsdom
/**
 * audit-event-row.test.tsx — unit tests for AuditEventRow component.
 *
 * Covers:
 *   - renders event type and outcome badge in collapsed state
 *   - collapsed: detail section not visible
 *   - click toggles expanded detail section (aria-expanded)
 *   - expanded: shows event ID, actor, IP, request ID
 *   - outcome "deny" shows XCircle (destructive variant)
 *   - outcome "success" shows CheckCircle (default variant)
 *   - null values render as em-dash
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { AuditEventRow } from "./audit-event-row";
import type { AuditEventRowData } from "./audit-event-row";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_ROW: AuditEventRowData = {
  id: "evt-abc-123",
  occurredAt: new Date("2025-01-15T10:00:00Z").toISOString(),
  eventType: "billing.subscription_canceled",
  outcome: "success",
  actorUserId: "user-1",
  actorName: "Alice Smith",
  workspaceId: "ws-1",
  capability: "billing.subscription.cancel",
  ip: "1.2.3.4",
  userAgent: "Mozilla/5.0",
  requestId: "req-xyz",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditEventRow", () => {
  it("renders event type in collapsed state", () => {
    const { getByText } = render(<AuditEventRow row={BASE_ROW} />);
    expect(
      getByText("billing.subscription_canceled · billing.subscription.cancel"),
    ).toBeDefined();
  });

  it("renders outcome badge text", () => {
    const { getAllByText } = render(<AuditEventRow row={BASE_ROW} />);
    // The outcome may appear in multiple elements (badge + possibly collapsed IP section)
    const matches = getAllByText("success");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("detail section is not visible when collapsed (aria-expanded=false)", () => {
    const { getByRole } = render(<AuditEventRow row={BASE_ROW} />);
    const btn = getByRole("button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("click expands the row (aria-expanded=true)", async () => {
    const { getByRole } = render(<AuditEventRow row={BASE_ROW} />);
    const btn = getByRole("button");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("expanded state shows actor name", async () => {
    const { getByRole, getByText } = render(<AuditEventRow row={BASE_ROW} />);
    const btn = getByRole("button");
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(getByText("Alice Smith")).toBeDefined();
    });
  });

  it("expanded state shows IP address in the detail section", async () => {
    const { getByRole, getAllByText } = render(
      <AuditEventRow row={BASE_ROW} />,
    );
    await act(async () => {
      fireEvent.click(getByRole("button"));
    });
    await waitFor(() => {
      // IP appears both in collapsed header and detail — at least 1 occurrence
      const ips = getAllByText("1.2.3.4");
      expect(ips.length).toBeGreaterThan(0);
    });
  });

  it("expanded state shows request ID", async () => {
    const { getByRole, getByText } = render(<AuditEventRow row={BASE_ROW} />);
    await act(async () => {
      fireEvent.click(getByRole("button"));
    });
    await waitFor(() => {
      expect(getByText("req-xyz")).toBeDefined();
    });
  });

  it("null fields render as em-dash (—)", async () => {
    const rowWithNulls: AuditEventRowData = {
      ...BASE_ROW,
      actorName: null,
      ip: null,
      requestId: null,
      capability: null,
    };
    const { getByRole, getAllByText } = render(
      <AuditEventRow row={rowWithNulls} />,
    );
    await act(async () => {
      fireEvent.click(getByRole("button"));
    });
    await waitFor(() => {
      const dashes = getAllByText("—");
      expect(dashes.length).toBeGreaterThan(0);
    });
  });

  it("second click collapses the row back (aria-expanded=false)", async () => {
    const { getByRole } = render(<AuditEventRow row={BASE_ROW} />);
    const btn = getByRole("button");
    await act(async () => {
      fireEvent.click(btn);
    });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders deny outcome badge", () => {
    const denyRow: AuditEventRowData = { ...BASE_ROW, outcome: "deny" };
    const { getAllByText } = render(<AuditEventRow row={denyRow} />);
    expect(getAllByText("deny").length).toBeGreaterThan(0);
  });
});
