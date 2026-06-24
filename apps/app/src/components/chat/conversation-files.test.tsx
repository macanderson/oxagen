// @vitest-environment jsdom
/**
 * conversation-files.test.tsx
 *
 * Render + interaction tests for ConversationFiles:
 *   - Renders the trigger button (Paperclip icon) in idle state
 *   - Shows a loading spinner while the fetch is in flight
 *   - Shows conversation files (filename, size, timestamp) after data loads
 *   - Renders an inline "open in new tab" affordance for images/video and a
 *     "download" affordance for documents/archives
 *   - Shows an info Alert (not an error) when there are no assets
 *   - Treats an HTTP 404 as "no files" — never surfaces a scary error
 *   - Shows an error Alert + Retry button when the fetch genuinely fails
 *   - Does not fetch when there is no active conversation
 */

import * as React from "react";
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
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      aria-label={ariaLabel}
      {...rest}
    >
      {children}
    </button>
  ),
}));

// Alert primitives — render semantic roles so empty/error states are assertable.
vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <div role="alert" data-variant={variant}>
      {children}
    </div>
  ),
  AlertTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    FileText: vi.fn(() => <span data-testid="icon-file-text" />),
    FileArchive: vi.fn(() => <span data-testid="icon-file-archive" />),
    FileSpreadsheet: vi.fn(() => <span data-testid="icon-file-spreadsheet" />),
    Presentation: vi.fn(() => <span data-testid="icon-presentation" />),
    File: vi.fn(() => <span data-testid="icon-file" />),
    Image: vi.fn(() => <span data-testid="icon-image" />),
    Video: vi.fn(() => <span data-testid="icon-video" />),
    ExternalLink: vi.fn(() => <span data-testid="icon-external-link" />),
    Download: vi.fn(() => <span data-testid="icon-download" />),
    Paperclip: vi.fn(() => <span data-testid="icon-paperclip" />),
    LoaderCircle: vi.fn(() => <span data-testid="icon-loader" />),
  };
});

const MOCK_ASSETS = [
  {
    publicId: "asset_1",
    name: "quarterly-revenue-chart.png",
    kind: "image",
    mimeType: "image/png",
    url: "/api/v1/assets/asset_1",
    createdAt: "2026-06-23T18:34:00.000Z",
    sizeBytes: 1024,
    status: "ready",
    accessPolicy: "org",
  },
  {
    // An office document — NOT browser-renderable, so it downloads.
    publicId: "asset_2",
    name: "onboarding-checklist.docx",
    kind: "document",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    url: "/api/v1/assets/asset_2",
    createdAt: "2026-06-23T18:35:00.000Z",
    sizeBytes: 20480,
    status: "ready",
    accessPolicy: "org",
  },
  {
    // A PDF — browser-renderable, so clicking the name opens it inline.
    publicId: "asset_3",
    name: "polar-crossing-report.pdf",
    kind: "pdf",
    mimeType: "application/pdf",
    url: "/api/v1/assets/asset_3",
    createdAt: "2026-06-23T18:36:00.000Z",
    sizeBytes: 4096,
    status: "ready",
    accessPolicy: "org",
  },
];

describe("ConversationFiles", () => {
  it("renders without crashing in idle state", async () => {
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    expect(document.body).toBeInTheDocument();
  });

  it("shows the loading spinner while the fetch is in flight", async () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("icon-loader")).toBeInTheDocument();
    });
  });

  it("shows filenames, sizes and timestamps when the fetch succeeds", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(MOCK_ASSETS),
    });
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    await waitFor(() => {
      expect(screen.getByText("quarterly-revenue-chart.png")).toBeInTheDocument();
      expect(screen.getByText("onboarding-checklist.docx")).toBeInTheDocument();
      expect(screen.getByText("polar-crossing-report.pdf")).toBeInTheDocument();
    });
    // Human-readable size is rendered (1024 B → "1.0 KB", 20480 B → "20.0 KB").
    expect(screen.getByText(/1\.0 KB/)).toBeInTheDocument();
    expect(screen.getByText(/20\.0 KB/)).toBeInTheDocument();
  });

  it("opens renderable files (image, pdf) in a new tab; downloads office docs", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(MOCK_ASSETS),
    });
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    await waitFor(() => {
      expect(screen.getByText("quarterly-revenue-chart.png")).toBeInTheDocument();
    });

    // The image filename link opens inline in a new tab.
    const imgLink = screen.getByText("quarterly-revenue-chart.png").closest("a")!;
    expect(imgLink).toHaveAttribute("href", "/api/v1/assets/asset_1");
    expect(imgLink).toHaveAttribute("target", "_blank");
    expect(imgLink).not.toHaveAttribute("download");

    // The PDF is browser-renderable → also opens in a new tab to view.
    const pdfLink = screen.getByText("polar-crossing-report.pdf").closest("a")!;
    expect(pdfLink).toHaveAttribute("href", "/api/v1/assets/asset_3");
    expect(pdfLink).toHaveAttribute("target", "_blank");
    expect(pdfLink).not.toHaveAttribute("download");

    // The .docx is NOT renderable → downloads to the machine (download attr set, no target).
    const docLink = screen.getByText("onboarding-checklist.docx").closest("a")!;
    expect(docLink).toHaveAttribute("href", "/api/v1/assets/asset_2");
    expect(docLink).toHaveAttribute("download", "onboarding-checklist.docx");
    expect(docLink).not.toHaveAttribute("target");

    // Open-in-new-tab affordance exists for the two viewable files (image, pdf).
    expect(screen.getAllByLabelText(/Open .* in a new tab/).length).toBe(2);

    // EVERY row has a dedicated Download button whose `download` attr is the slug
    // filename — this is what forces the file to save as a human-readable name
    // rather than the opaque gen_ id (the user's reported bug).
    const imgDownload = screen.getByLabelText("Download quarterly-revenue-chart.png");
    expect(imgDownload).toHaveAttribute("download", "quarterly-revenue-chart.png");
    expect(imgDownload).toHaveAttribute("href", "/api/v1/assets/asset_1");

    const pdfDownload = screen.getByLabelText("Download polar-crossing-report.pdf");
    expect(pdfDownload).toHaveAttribute("download", "polar-crossing-report.pdf");

    expect(screen.getByLabelText("Download onboarding-checklist.docx")).toHaveAttribute(
      "download",
      "onboarding-checklist.docx",
    );
  });

  it("shows an info Alert (not an error) when there are no assets", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    await waitFor(() => {
      expect(screen.getByText("No files yet")).toBeInTheDocument();
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-variant", "info");
  });

  it("treats an HTTP 404 as 'no files' rather than an error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: { code: "not_found" } }),
    });
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    await waitFor(() => {
      expect(screen.getByText("No files yet")).toBeInTheDocument();
    });
    // The info variant proves it took the empty path, not the error path.
    expect(screen.getByRole("alert")).toHaveAttribute("data-variant", "info");
    // And the raw "404" string is never shown to the user.
    expect(screen.queryByText(/404/)).not.toBeInTheDocument();
  });

  it("shows an error Alert and a Retry button when the fetch fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId="conv_abc" />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    await waitFor(() => {
      expect(screen.getByText("Couldn't load files (HTTP 500)")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveAttribute("data-variant", "error");
  });

  it("does not fetch when conversationPublicId is null", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const { ConversationFiles } = await import("./conversation-files");
    render(<ConversationFiles conversationPublicId={null} />);
    await userEvent.click(screen.getByTestId("sheet-open-trigger"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
