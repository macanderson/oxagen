// @vitest-environment jsdom
/**
 * attach-tray.test.tsx
 *
 * The chat_ux_v2 mobile attach tray (bottom sheet opened by the condensed
 * row's plus button). Covers: the three expected rows render with NO
 * "Record voice" row (the server has no "audio" asset kind — see
 * packages/storage/src/assets.ts), each row's hidden input has the honest
 * `accept` for what it claims to offer, picking a file routes to the right
 * callback and closes the tray, and an empty pick (cancel) doesn't fire the
 * callback or leave the tray dangling in a bad state.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

// Sheet is a Base UI Dialog under the hood (portal + focus trap); mocked to
// render inline (open-gated) the same way message-composer-v2.test.tsx mocks
// the composer's own overflow sheet.
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="sheet-root">{children}</div> : null,
  SheetPopup: ({
    children,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    side?: string;
    "data-testid"?: string;
  }) => <div data-testid={testId ?? "sheet-popup"}>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetPanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

import { AttachTray } from "./attach-tray";

describe("AttachTray", () => {
  it("renders nothing when closed", () => {
    render(
      <AttachTray
        open={false}
        onOpenChange={vi.fn()}
        onCapturePhoto={vi.fn()}
        onPickPhotos={vi.fn()}
        onPickDocuments={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("attach-tray")).not.toBeInTheDocument();
  });

  it("renders exactly the three expected rows — no Record voice row", () => {
    render(
      <AttachTray
        open
        onOpenChange={vi.fn()}
        onCapturePhoto={vi.fn()}
        onPickPhotos={vi.fn()}
        onPickDocuments={vi.fn()}
      />,
    );
    expect(screen.getByTestId("attach-tray")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take photo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose photos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose files" })).toBeInTheDocument();
    // The server has no "audio" asset kind (packages/storage/src/assets.ts)
    // — a voice-recording row would 415 on every attempt, so it must not exist.
    expect(
      screen.queryByRole("button", { name: /record voice/i }),
    ).not.toBeInTheDocument();
  });

  it("wires honest accept/capture attributes per row", () => {
    const { container } = render(
      <AttachTray
        open
        onOpenChange={vi.fn()}
        onCapturePhoto={vi.fn()}
        onPickPhotos={vi.fn()}
        onPickDocuments={vi.fn()}
      />,
    );
    const inputs = container.querySelectorAll('input[type="file"]');
    expect(inputs).toHaveLength(3);
    const [camera, photos, documents] = Array.from(inputs) as HTMLInputElement[];
    expect(camera!.accept).toBe("image/*");
    // jsdom doesn't reflect the non-standard `capture` attribute as an IDL
    // property, so read the raw attribute.
    expect(camera!.getAttribute("capture")).toBe("environment");
    expect(photos!.accept).toBe("image/*,video/*");
    expect(photos!.multiple).toBe(true);
    // "Choose files" is scoped to PDF only — the one type "document" adds
    // beyond what "Choose photos" already covers; it must never overlap or
    // silently accept a type the server would reject.
    expect(documents!.accept).toBe("application/pdf");
    expect(documents!.multiple).toBe(true);
  });

  it("Take photo click opens the camera input; picking a file calls onCapturePhoto and closes the tray", async () => {
    const user = userEvent.setup();
    const onCapturePhoto = vi.fn();
    const onOpenChange = vi.fn();
    const { container } = render(
      <AttachTray
        open
        onOpenChange={onOpenChange}
        onCapturePhoto={onCapturePhoto}
        onPickPhotos={vi.fn()}
        onPickDocuments={vi.fn()}
      />,
    );
    const cameraInput = container.querySelector(
      'input[accept="image/*"]',
    ) as HTMLInputElement;
    const file = new File(["x"], "selfie.png", { type: "image/png" });
    await user.click(screen.getByRole("button", { name: "Take photo" }));
    await user.upload(cameraInput, file);

    expect(onCapturePhoto).toHaveBeenCalledTimes(1);
    const files = onCapturePhoto.mock.calls[0]![0] as FileList;
    expect(files[0]!.name).toBe("selfie.png");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Choose photos routes to onPickPhotos and closes the tray", async () => {
    const user = userEvent.setup();
    const onPickPhotos = vi.fn();
    const onOpenChange = vi.fn();
    const { container } = render(
      <AttachTray
        open
        onOpenChange={onOpenChange}
        onCapturePhoto={vi.fn()}
        onPickPhotos={onPickPhotos}
        onPickDocuments={vi.fn()}
      />,
    );
    const photosInput = container.querySelector(
      'input[accept="image/*,video/*"]',
    ) as HTMLInputElement;
    await user.upload(
      photosInput,
      new File(["v"], "clip.mp4", { type: "video/mp4" }),
    );

    expect(onPickPhotos).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Choose files routes to onPickDocuments and closes the tray", async () => {
    const user = userEvent.setup();
    const onPickDocuments = vi.fn();
    const onOpenChange = vi.fn();
    const { container } = render(
      <AttachTray
        open
        onOpenChange={onOpenChange}
        onCapturePhoto={vi.fn()}
        onPickPhotos={vi.fn()}
        onPickDocuments={onPickDocuments}
      />,
    );
    const documentsInput = container.querySelector(
      'input[accept="application/pdf"]',
    ) as HTMLInputElement;
    await user.upload(
      documentsInput,
      new File(["p"], "spec.pdf", { type: "application/pdf" }),
    );

    expect(onPickDocuments).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("an empty pick (cancel) never fires the callback or closes the tray", () => {
    const onPickPhotos = vi.fn();
    const onOpenChange = vi.fn();
    const { container } = render(
      <AttachTray
        open
        onOpenChange={onOpenChange}
        onCapturePhoto={vi.fn()}
        onPickPhotos={onPickPhotos}
        onPickDocuments={vi.fn()}
      />,
    );
    const photosInput = container.querySelector(
      'input[accept="image/*,video/*"]',
    ) as HTMLInputElement;
    // Simulate the native "Cancel" flow: onChange fires with an empty FileList.
    fireEvent.change(photosInput, { target: { files: [] } });

    expect(onPickPhotos).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
