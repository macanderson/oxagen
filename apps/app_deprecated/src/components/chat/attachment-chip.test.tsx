// @vitest-environment jsdom
/**
 * attachment-chip.test.tsx
 *
 * Unit tests for the composer's pending/sent attachment chip:
 *   - Renders an image thumbnail for image files
 *   - Renders a generic file icon for non-image files
 *   - Shows the upload-progress overlay while status === "uploading"
 *   - Shows the error overlay while status === "error"
 *   - Remove fires onRemove with the attachment id
 *   - hasInFlightUploads reflects whether any attachment is still uploading
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AttachmentChip,
  hasInFlightUploads,
  type PendingAttachment,
} from "./attachment-chip";

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
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
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

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => (
    // eslint-disable-next-line @next/next/no-img-element -- test stub for next/image
    <img alt={alt} src={src} data-testid="thumbnail" />
  ),
}));

vi.mock("lucide-react", () => ({
  X: () => <span data-testid="icon-x" />,
  FileText: () => <span data-testid="icon-file" />,
  Film: () => <span data-testid="icon-film" />,
  Loader2: () => <span data-testid="icon-loader" />,
  AlertCircle: () => <span data-testid="icon-alert" />,
}));

function makeAttachment(
  overrides: Partial<PendingAttachment> = {},
): PendingAttachment {
  return {
    id: "att-1",
    file: new File(["x"], "photo.png", { type: "image/png" }),
    previewUrl: "blob:local-preview",
    status: "uploaded",
    progress: 100,
    publicId: "gen_abc",
    kind: "image",
    mimeType: "image/png",
    url: "/api/v1/assets/gen_abc",
    name: "photo.png",
    ...overrides,
  };
}

describe("AttachmentChip", () => {
  it("renders an image thumbnail for an image file", () => {
    render(<AttachmentChip attachment={makeAttachment()} onRemove={vi.fn()} />);
    expect(screen.getByTestId("thumbnail")).toHaveAttribute(
      "src",
      "blob:local-preview",
    );
  });

  it("renders a generic file icon for a non-image file", () => {
    const attachment = makeAttachment({
      file: new File(["x"], "notes.pdf", { type: "application/pdf" }),
    });
    render(<AttachmentChip attachment={attachment} onRemove={vi.fn()} />);
    expect(screen.queryByTestId("thumbnail")).not.toBeInTheDocument();
    expect(screen.getByTestId("icon-file")).toBeInTheDocument();
  });

  it("shows the upload-progress overlay while uploading", () => {
    const attachment = makeAttachment({ status: "uploading", progress: 42 });
    render(<AttachmentChip attachment={attachment} onRemove={vi.fn()} />);
    const chip = screen.getByTestId("attachment-chip");
    expect(chip).toHaveAttribute("data-status", "uploading");
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
  });

  it("shows the error overlay when the upload failed", () => {
    const attachment = makeAttachment({
      status: "error",
      error: "File too large",
    });
    render(<AttachmentChip attachment={attachment} onRemove={vi.fn()} />);
    expect(screen.getByTestId("attachment-chip")).toHaveAttribute(
      "data-status",
      "error",
    );
    expect(screen.getByTestId("icon-alert")).toBeInTheDocument();
  });

  it("calls onRemove with the attachment id when the remove button is clicked", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <AttachmentChip
        attachment={makeAttachment({ id: "att-42" })}
        onRemove={onRemove}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /remove photo\.png/i }),
    );

    expect(onRemove).toHaveBeenCalledWith("att-42");
  });

  it("shows no retry affordance when onRetry is omitted, even on error", () => {
    const attachment = makeAttachment({
      status: "error",
      error: "Upload failed",
    });
    render(<AttachmentChip attachment={attachment} onRemove={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  it("calls onRetry with the attachment id when the retry button is clicked", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const attachment = makeAttachment({
      id: "att-9",
      status: "error",
      error: "Upload failed",
    });
    render(
      <AttachmentChip
        attachment={attachment}
        onRemove={vi.fn()}
        onRetry={onRetry}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /retry upload for photo\.png/i }),
    );

    expect(onRetry).toHaveBeenCalledWith("att-9");
  });

  it("no retry affordance while uploading or once uploaded", () => {
    render(
      <AttachmentChip
        attachment={makeAttachment({ status: "uploading", progress: 10 })}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
    cleanup();
    render(
      <AttachmentChip
        attachment={makeAttachment({ status: "uploaded" })}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  it("default (non-compact) rendering has no filename caption for a non-image kind", () => {
    const attachment = makeAttachment({
      file: new File(["v"], "clip.mp4", { type: "video/mp4" }),
      name: "clip.mp4",
      kind: "video",
      mimeType: "video/mp4",
    });
    render(<AttachmentChip attachment={attachment} onRemove={vi.fn()} />);
    expect(screen.queryByText("clip.mp4")).not.toBeInTheDocument();
  });

  it("compact mode adds a visible filename caption under a non-image chip", () => {
    const attachment = makeAttachment({
      file: new File(["v"], "clip.mp4", { type: "video/mp4" }),
      name: "clip.mp4",
      kind: "video",
      mimeType: "video/mp4",
    });
    render(
      <AttachmentChip attachment={attachment} onRemove={vi.fn()} compact />,
    );
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
  });

  it("compact mode does NOT add a caption for an image chip (thumbnail already shows it)", () => {
    render(
      <AttachmentChip
        attachment={makeAttachment()}
        onRemove={vi.fn()}
        compact
      />,
    );
    // "photo.png" only appears as the thumbnail's alt text, never as a caption span.
    expect(screen.queryAllByText("photo.png")).toHaveLength(0);
  });
});

describe("hasInFlightUploads", () => {
  it("returns false for an empty list", () => {
    expect(hasInFlightUploads([])).toBe(false);
  });

  it("returns false when every attachment finished (uploaded or error)", () => {
    expect(
      hasInFlightUploads([
        makeAttachment({ id: "a", status: "uploaded" }),
        makeAttachment({ id: "b", status: "error" }),
      ]),
    ).toBe(false);
  });

  it("returns true when any attachment is still uploading", () => {
    expect(
      hasInFlightUploads([
        makeAttachment({ id: "a", status: "uploaded" }),
        makeAttachment({ id: "b", status: "uploading" }),
      ]),
    ).toBe(true);
  });
});
