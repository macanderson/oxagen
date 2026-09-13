// @vitest-environment jsdom
/**
 * audit-export-buttons.test.tsx — unit tests for AuditExportButtons component.
 *
 * Covers:
 *   - canExport=false: renders two disabled buttons with Lock icon (title from disabledReason)
 *   - canExport=true: renders two enabled export links (NDJSON + CSV)
 *   - export hrefs include format=ndjson / format=csv
 *   - active URL params are forwarded to the href (minus cursor)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AuditExportButtons } from "./audit-export-buttons";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// next/navigation mock (usePathname + useSearchParams)
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/security/audit",
  useSearchParams: () =>
    new URLSearchParams(
      "event_type=billing.subscription_canceled&cursor=tok-123",
    ),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditExportButtons", () => {
  it("renders disabled locked buttons when canExport=false", () => {
    const { getAllByRole } = render(
      <AuditExportButtons
        canExport={false}
        disabledReason="Upgrade to Enterprise to export"
      />,
    );
    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect((buttons[0] as HTMLButtonElement)?.disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement)?.disabled).toBe(true);
    // Both buttons should have the title from disabledReason
    expect(buttons[0]?.getAttribute("title")).toBe(
      "Upgrade to Enterprise to export",
    );
  });

  it("renders enabled export links when canExport=true", () => {
    const { getAllByText } = render(
      <AuditExportButtons canExport={true} disabledReason="" />,
    );
    expect(getAllByText("Export NDJSON").length).toBeGreaterThan(0);
    expect(getAllByText("Export CSV").length).toBeGreaterThan(0);
  });

  it("NDJSON link includes format=ndjson query param", () => {
    const { container } = render(
      <AuditExportButtons canExport={true} disabledReason="" />,
    );
    const anchors = container.querySelectorAll("a");
    const ndjsonAnchor = Array.from(anchors).find((a) =>
      a.getAttribute("href")?.includes("format=ndjson"),
    );
    expect(ndjsonAnchor).toBeDefined();
  });

  it("CSV link includes format=csv query param", () => {
    const { container } = render(
      <AuditExportButtons canExport={true} disabledReason="" />,
    );
    const anchors = container.querySelectorAll("a");
    const csvAnchor = Array.from(anchors).find((a) =>
      a.getAttribute("href")?.includes("format=csv"),
    );
    expect(csvAnchor).toBeDefined();
  });

  it("export href preserves active filter params", () => {
    const { container } = render(
      <AuditExportButtons canExport={true} disabledReason="" />,
    );
    const anchors = container.querySelectorAll("a");
    const ndjsonAnchor = Array.from(anchors).find((a) =>
      a.getAttribute("href")?.includes("format=ndjson"),
    );
    const href = ndjsonAnchor?.getAttribute("href") ?? "";
    expect(href).toContain("event_type=billing.subscription_canceled");
  });

  it("export href drops the cursor param", () => {
    const { container } = render(
      <AuditExportButtons canExport={true} disabledReason="" />,
    );
    const anchors = container.querySelectorAll("a");
    const ndjsonAnchor = Array.from(anchors).find((a) =>
      a.getAttribute("href")?.includes("format=ndjson"),
    );
    const href = ndjsonAnchor?.getAttribute("href") ?? "";
    expect(href).not.toContain("cursor=");
  });

  it("export href points to the /export sub-path", () => {
    const { container } = render(
      <AuditExportButtons canExport={true} disabledReason="" />,
    );
    const anchors = container.querySelectorAll("a");
    const ndjsonAnchor = Array.from(anchors).find((a) =>
      a.getAttribute("href")?.includes("format=ndjson"),
    );
    expect(ndjsonAnchor?.getAttribute("href")).toContain("/export");
  });
});
