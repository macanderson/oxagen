// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PendingAttachment } from "./attachment-chip";

afterEach(cleanup);

function makeAttachment(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    id: "att-1",
    kind: "image",
    name: "cat.png",
    mimeType: "image/png",
    status: "done",
    sizeBytes: 2048,
    url: "/api/v1/assets/gen_1",
    ...overrides,
  };
}

describe("AttachmentChip", () => {
  it("renders the attachment name", async () => {
    const { AttachmentChip } = await import("./attachment-chip");
    render(<AttachmentChip attachment={makeAttachment()} onRemove={vi.fn()} />);
    expect(screen.getByText("cat.png")).toBeInTheDocument();
  });

  it("shows a formatted size for a completed upload", async () => {
    const { AttachmentChip } = await import("./attachment-chip");
    render(<AttachmentChip attachment={makeAttachment({ sizeBytes: 2048 })} onRemove={vi.fn()} />);
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("shows a progress bar while uploading", async () => {
    const { AttachmentChip } = await import("./attachment-chip");
    render(
      <AttachmentChip
        attachment={makeAttachment({ status: "uploading", progress: 42 })}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Uploading cat.png")).toBeInTheDocument();
  });

  it("shows the error message when upload fails", async () => {
    const { AttachmentChip } = await import("./attachment-chip");
    render(
      <AttachmentChip
        attachment={makeAttachment({ status: "error", error: "Too large" })}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText("Too large")).toBeInTheDocument();
    expect(screen.getByLabelText("Failed to upload cat.png")).toBeInTheDocument();
  });

  it("calls onRemove with the attachment id when the remove button is clicked", async () => {
    const onRemove = vi.fn();
    const { AttachmentChip } = await import("./attachment-chip");
    render(<AttachmentChip attachment={makeAttachment({ id: "att-42" })} onRemove={onRemove} />);
    await userEvent.click(screen.getByLabelText("Remove cat.png"));
    expect(onRemove).toHaveBeenCalledWith("att-42");
  });

  it("renders a thumbnail image when a preview or url is present for image kind", async () => {
    const { AttachmentChip } = await import("./attachment-chip");
    render(
      <AttachmentChip
        attachment={makeAttachment({ kind: "image", url: "/api/v1/assets/gen_2" })}
        onRemove={vi.fn()}
      />,
    );
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "/api/v1/assets/gen_2");
  });

  it("does not render an <img> for non-image kinds", async () => {
    const { AttachmentChip } = await import("./attachment-chip");
    render(
      <AttachmentChip
        attachment={makeAttachment({ kind: "video", name: "clip.mp4" })}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
