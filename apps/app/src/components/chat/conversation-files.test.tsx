// @vitest-environment jsdom
/**
 * conversation-files.test.tsx
 *
 * Render + interaction tests for ConversationFilesList — the single list body
 * mounted by the chat side-panel's "Files" tab (the old Sheet-based drawer was
 * removed as duplicate UI):
 *   - Does not fetch while inactive; renders without crashing
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

// Spread the real module so formatBytes (used for the size column) and any
// other util stay intact — a full-replacement mock silently drops them and
// throws "No X export is defined on the mock" at render time.
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Alert primitives — render semantic roles so empty/error states are assertable.
vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    children,
    variant,
  }: {
    children: React.ReactNode;
    variant?: string;
  }) => (
    <div role="alert" data-variant={variant}>
      {children}
    </div>
  ),
  AlertTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Dialog primitives — used by the in-app SVG preview. Rendered only when open
// so assertions can key off the dialog's presence.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (v: boolean) => void;
  }) => (open ? <div data-testid="preview-dialog">{children}</div> : null),
  DialogPopup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="preview-dialog-popup">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
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
  {
    // An SVG — served with attachment disposition (stored-XSS defence), so it
    // previews IN-APP via <img> instead of opening/downloading directly.
    publicId: "asset_4",
    name: "agentic-flow-diagram.svg",
    kind: "image",
    mimeType: "image/svg+xml",
    url: "/api/v1/assets/asset_4",
    createdAt: "2026-06-23T18:37:00.000Z",
    sizeBytes: 2048,
    status: "ready",
    accessPolicy: "org",
  },
];

describe("ConversationFilesList", () => {
  it("renders without crashing and does not fetch while inactive", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={false} />,
    );
    expect(document.body).toBeInTheDocument();
    // Inactive lists never hit the network — the fetch only fires while the
    // "Files" tab is the visible tab.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the loading spinner while the fetch is in flight", async () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
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
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("quarterly-revenue-chart.png"),
      ).toBeInTheDocument();
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
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("quarterly-revenue-chart.png"),
      ).toBeInTheDocument();
    });

    // The image filename link opens inline in a new tab.
    const imgLink = screen
      .getByText("quarterly-revenue-chart.png")
      .closest("a")!;
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
    const imgDownload = screen.getByLabelText(
      "Download quarterly-revenue-chart.png",
    );
    expect(imgDownload).toHaveAttribute(
      "download",
      "quarterly-revenue-chart.png",
    );
    expect(imgDownload).toHaveAttribute("href", "/api/v1/assets/asset_1");

    const pdfDownload = screen.getByLabelText(
      "Download polar-crossing-report.pdf",
    );
    expect(pdfDownload).toHaveAttribute(
      "download",
      "polar-crossing-report.pdf",
    );

    expect(
      screen.getByLabelText("Download onboarding-checklist.docx"),
    ).toHaveAttribute("download", "onboarding-checklist.docx");
  });

  it("renders inline <img> thumbnails for image rows (including SVG)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(MOCK_ASSETS),
    });
    const { ConversationFilesList } = await import("./conversation-files");
    const { container } = render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
    await waitFor(() => {
      expect(screen.getByText("agentic-flow-diagram.svg")).toBeInTheDocument();
    });

    // Both image-kind rows render an <img> thumbnail sourced from the
    // auth-gated serving route. <img> ignores Content-Disposition and never
    // executes SVG scripts, so this is XSS-safe for SVG too.
    const thumbs = Array.from(container.querySelectorAll("img"));
    const srcs = thumbs.map((t) => t.getAttribute("src"));
    expect(srcs).toContain("/api/v1/assets/asset_1"); // png
    expect(srcs).toContain("/api/v1/assets/asset_4"); // svg
    // Non-image rows get no thumbnail.
    expect(srcs).not.toContain("/api/v1/assets/asset_2");
    expect(srcs).not.toContain("/api/v1/assets/asset_3");
  });

  it("SVG rows open an in-app preview dialog with an <img> and a Download button", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(MOCK_ASSETS),
    });
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
    await waitFor(() => {
      expect(screen.getByText("agentic-flow-diagram.svg")).toBeInTheDocument();
    });

    // The SVG name is a BUTTON (in-app preview), never a direct open/download
    // anchor — mobile browsers bounce the attachment-disposition SVG download
    // with "file not supported".
    const nameEl = screen.getByText("agentic-flow-diagram.svg");
    expect(nameEl.closest("a")).toBeNull();
    expect(screen.queryByTestId("preview-dialog")).not.toBeInTheDocument();

    await userEvent.click(nameEl);

    const dialog = await screen.findByTestId("preview-dialog");
    // Full-size preview rendered via <img> against the serving route
    // (XSS-safe: the image decoder never executes scripts).
    const img = dialog.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/api/v1/assets/asset_4");
    // Download button inside the dialog carries the slug filename.
    const dialogDownloads = Array.from(dialog.querySelectorAll("a[download]"));
    expect(
      dialogDownloads.some(
        (a) =>
          a.getAttribute("href") === "/api/v1/assets/asset_4" &&
          a.getAttribute("download") === "agentic-flow-diagram.svg",
      ),
    ).toBe(true);
  });

  it("SVG rows still expose a direct Download action button", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(MOCK_ASSETS),
    });
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
    await waitFor(() => {
      expect(screen.getByText("agentic-flow-diagram.svg")).toBeInTheDocument();
    });

    const download = screen.getByLabelText("Download agentic-flow-diagram.svg");
    expect(download).toHaveAttribute("href", "/api/v1/assets/asset_4");
    expect(download).toHaveAttribute("download", "agentic-flow-diagram.svg");
    // But no "open in new tab" affordance — that navigation is the forced
    // download mobile browsers can't handle.
    expect(
      screen.queryByLabelText("Open agentic-flow-diagram.svg in a new tab"),
    ).not.toBeInTheDocument();
  });

  it("offers 'Download all' as a ZIP once MORE THAN ONE file exists", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(MOCK_ASSETS),
    });
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("quarterly-revenue-chart.png"),
      ).toBeInTheDocument();
    });

    // The header shows the count and a "Download all" anchor pointed at the
    // conversation's archive route, marked `download` so the browser saves the
    // streamed ZIP instead of navigating.
    expect(screen.getByText("4 files")).toBeInTheDocument();
    const downloadAll = screen.getByLabelText(
      "Download all 4 files as a ZIP archive",
    );
    expect(downloadAll).toHaveAttribute(
      "href",
      "/api/v1/conversations/conv_abc/assets/archive",
    );
    expect(downloadAll).toHaveAttribute("download");
  });

  it("hides 'Download all' when the conversation has only one file", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([MOCK_ASSETS[0]]),
    });
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("quarterly-revenue-chart.png"),
      ).toBeInTheDocument();
    });
    // A single file's row already has its own Download button — the bulk ZIP
    // affordance only appears from the second file onward.
    expect(
      screen.queryByLabelText(/Download all .* as a ZIP archive/),
    ).toBeNull();
    expect(screen.queryByText(/files$/)).toBeNull();
  });

  it("shows an info Alert (not an error) when there are no assets", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
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
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
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
    const { ConversationFilesList } = await import("./conversation-files");
    render(
      <ConversationFilesList conversationPublicId="conv_abc" active={true} />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("Couldn't load files (HTTP 500)"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveAttribute("data-variant", "error");
  });

  it("does not fetch when conversationPublicId is null", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const { ConversationFilesList } = await import("./conversation-files");
    render(<ConversationFilesList conversationPublicId={null} active={true} />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
