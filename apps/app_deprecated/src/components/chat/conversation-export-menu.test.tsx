// @vitest-environment jsdom
/**
 * conversation-export-menu.test.tsx
 *
 * Render + interaction tests for ConversationExportMenu:
 *   - Renders the trigger button with an accessible export label
 *   - "Export as Markdown" fetches format=markdown and downloads a blob with
 *     the server-provided filename
 *   - "Export as PDF" fetches format=pdf and opens the serve URL in a new tab
 *   - A failed fetch surfaces an error toast (no crash)
 *   - Missing content in a markdown response surfaces an error toast
 *   - Below 768px the bottom-sheet variant renders ≥44px touch rows
 */

import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

const toastAdd = vi.fn();

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
}));

// Menu primitives — trigger renders its `render` element with the trigger
// children inside; the popup is always visible so items are clickable.
vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactElement;
  }) => React.cloneElement(render, undefined, children),
  MenuPopup: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  MenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactElement;
  }) => React.cloneElement(render, undefined, children),
  SheetPopup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sheet-popup">{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

import { ConversationExportMenu } from "./conversation-export-menu";

// ── Environment stubs ─────────────────────────────────────────────────────────

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

const BASE_PROPS = {
  conversationId: "cnv_1",
  conversationTitle: "Planning",
  orgSlug: "acme",
  workspaceSlug: "growth",
};

const MD_RESPONSE = {
  format: "markdown",
  filename: "planning-2026-07-07.md",
  content: "# Planning\n",
  url: null,
  messageCount: 2,
};

const PDF_RESPONSE = {
  format: "pdf",
  filename: "planning-2026-07-07.pdf",
  content: null,
  url: "/api/v1/assets/gen_9",
  messageCount: 2,
};

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  toastAdd.mockReset();
  stubMatchMedia(false);
  vi.stubGlobal("open", vi.fn());
  URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ConversationExportMenu", () => {
  it("renders a trigger with an accessible export label", () => {
    render(<ConversationExportMenu {...BASE_PROPS} />);
    expect(
      screen.getByRole("button", { name: 'Export conversation "Planning"' }),
    ).toBeTruthy();
  });

  it("downloads markdown via a blob link with the server filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(MD_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(<ConversationExportMenu {...BASE_PROPS} />);
    await userEvent.click(
      screen.getByRole("menuitem", { name: /export as markdown/i }),
    );

    await waitFor(() => expect(clickSpy).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/conversations/cnv_1/export?format=markdown",
    );
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    expect(toastAdd).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("opens the PDF serve URL in a new tab", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(PDF_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    render(<ConversationExportMenu {...BASE_PROPS} />);
    await userEvent.click(
      screen.getByRole("menuitem", { name: /export as pdf/i }),
    );

    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "/api/v1/assets/gen_9",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/conversations/cnv_1/export?format=pdf",
    );
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("shows an error toast when the export request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 500 } as unknown as Response),
    );

    render(<ConversationExportMenu {...BASE_PROPS} />);
    await userEvent.click(
      screen.getByRole("menuitem", { name: /export as pdf/i }),
    );

    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Export failed", type: "error" }),
      ),
    );
    expect(window.open).not.toHaveBeenCalled();
  });

  it("shows an error toast when markdown content is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okJson({ ...MD_RESPONSE, content: null })),
    );

    render(<ConversationExportMenu {...BASE_PROPS} />);
    await userEvent.click(
      screen.getByRole("menuitem", { name: /export as markdown/i }),
    );

    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Export failed", type: "error" }),
      ),
    );
  });

  it("renders the bottom-sheet variant with ≥44px touch rows on mobile", async () => {
    stubMatchMedia(true);
    const fetchMock = vi.fn().mockResolvedValue(okJson(PDF_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    render(<ConversationExportMenu {...BASE_PROPS} />);

    await waitFor(() => expect(screen.getByTestId("sheet-popup")).toBeTruthy());
    const mdRow = screen.getByRole("button", { name: /export as markdown/i });
    const pdfRow = screen.getByRole("button", { name: /export as pdf/i });
    expect(mdRow.className).toContain("min-h-11");
    expect(pdfRow.className).toContain("min-h-11");

    await userEvent.click(pdfRow);
    await waitFor(() => expect(window.open).toHaveBeenCalled());
  });
});
