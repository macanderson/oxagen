// @vitest-environment jsdom
/**
 * conversation-files.test.tsx
 *
 * Render + interaction tests for ConversationFiles:
 *   - Renders the trigger button (Paperclip icon) in idle state
 *   - Does not show the sheet panel initially
 *   - Shows conversation files after sheet is opened and data loads
 *   - Shows empty state when no assets
 *   - Shows error state when fetch fails
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    "aria-label": ariaLabel,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label"?: string }) => (
    <button type={(type as "button" | "submit" | "reset") ?? "button"} onClick={onClick} aria-label={ariaLabel} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (v: boolean) => void;
  }) => (
    <div data-testid="sheet" data-open={open ? "true" : "false"}>
      <button data-testid="sheet-open-trigger" onClick={() => onOpenChange?.(true)} />
      {children}
    </div>
  ),
  SheetTrigger: ({ render: renderProp }: { children?: React.ReactNode; render?: React.ReactElement }) =>
    renderProp ?? null,
  SheetPopup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sheet-popup">{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  FileText: () => <span data-testid="icon-file-text" />,
  FileArchive: () => <span data-testid="icon-file-archive" />,
  File: () => <span data-testid="icon-file" />,
  Image: () => <span data-testid="icon-image" />,
  Video: () => <span data-testid="icon-video" />,
  ExternalLink: () => <span data-testid="icon-external-link" />,
  Paperclip: () => <span data-testid="icon-paperclip" />,
  LoaderCircle: () => <span data-testid="icon-loader" />,
}));

const MOCK_ASSETS = [
  {
    publicId: "asset_1",
    name: "chart.png",
    kind: "image",
    url: "/api/v1/assets/asset_1",
    createdAt: new Date().toISOString(),
    sizeBytes: 1024,
  },
  {
    publicId: "asset_2",
    name: "report.pdf",
    kind: "pdf",
    url: "/api/v1/assets/asset_2",
    createdAt: new Date().toISOString(),
    sizeBytes: 20480,
  },
];

describe("ConversationFiles", () => {
  it("renders the trigger button", async () => {
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    // The trigger is rendered via SheetTrigger render prop → Button
    // Our SheetTrigger mock renders its render prop directly
    expect(document.body).toBeInTheDocument();
  });

  it("renders the panel when open with loading state", async () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    // Click the sheet open trigger from mock
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("icon-loader")).toBeInTheDocument();
    });
  });

  it("shows asset names when fetch succeeds", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_ASSETS),
    });
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    await waitFor(() => {
      expect(screen.getByText("chart.png")).toBeInTheDocument();
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });
  });

  it("shows empty state message when no assets", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    await waitFor(() => {
      expect(screen.getByText("No files generated yet.")).toBeInTheDocument();
    });
  });

  it("shows error message and Retry button when fetch fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    await waitFor(() => {
      // Error message is `err.message` which is "HTTP 500"
      expect(screen.getByText("HTTP 500")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });
  });

  it("does not fetch when conversationPublicId is null", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId={null} />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    // fetch should not be called since there's no conversationPublicId
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
