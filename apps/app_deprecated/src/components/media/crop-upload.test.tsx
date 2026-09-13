// @vitest-environment jsdom
/**
 * crop-upload.test.tsx — tests for the shared crop/upload internals behind
 * both AvatarUpload and the AvatarMaker Photo tab:
 *   - getCroppedBlob: canvas crop → 512×512 WebP Blob (success + failure paths)
 *   - uploadAvatarBlob: POST /api/v1/upload/avatar → URL (success + error paths)
 *   - useCropUpload: the shared state machine (load → crop → save → reset)
 *   - CropSurface: the shared Cropper + zoom slider + error presentational block
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import type { Area } from "react-easy-crop";
import {
  getCroppedBlob,
  uploadAvatarBlob,
  useCropUpload,
  CropSurface,
} from "./crop-upload";

afterEach(cleanup);

// react-easy-crop relies on canvas/DOM measurement APIs that jsdom doesn't
// implement; stub it the same way avatar-upload.test.tsx does.
vi.mock("react-easy-crop", () => ({
  default: ({ zoom }: { zoom: number }) => (
    <div data-testid="cropper" data-zoom={zoom} />
  ),
}));
vi.mock("react-easy-crop/react-easy-crop.css", () => ({}));

const AREA: Area = { x: 0, y: 0, width: 100, height: 100 };

// ---------------------------------------------------------------------------
// getCroppedBlob
// ---------------------------------------------------------------------------

describe("getCroppedBlob", () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let originalToBlob: typeof HTMLCanvasElement.prototype.toBlob;

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    originalToBlob = HTMLCanvasElement.prototype.toBlob;

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      drawImage: vi.fn(),
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    HTMLCanvasElement.prototype.toBlob = vi.fn(function toBlob(
      callback: BlobCallback,
    ) {
      callback(new Blob(["fake-image-bytes"], { type: "image/webp" }));
    }) as unknown as typeof HTMLCanvasElement.prototype.toBlob;

    // jsdom's Image never fires load/error on its own; simulate a successful
    // async decode so getCroppedBlob's `await new Promise(...)` resolves.
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        private _src = "";
        addEventListener(event: string, cb: () => void) {
          if (event === "load") this.onload = cb;
        }
        set src(value: string) {
          this._src = value;
          queueMicrotask(() => this.onload?.());
        }
        get src() {
          return this._src;
        }
      },
    );
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
    vi.unstubAllGlobals();
  });

  it("resolves with a Blob for a valid image + crop area", async () => {
    const blob = await getCroppedBlob("data:image/png;base64,abc", AREA);
    expect(blob).toBeInstanceOf(Blob);
  });

  it("rejects when the canvas 2d context is unavailable", async () => {
    HTMLCanvasElement.prototype.getContext = vi
      .fn()
      .mockReturnValue(
        null,
      ) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    await expect(
      getCroppedBlob("data:image/png;base64,abc", AREA),
    ).rejects.toThrow(/canvas 2d context unavailable/i);
  });

  it("rejects when canvas.toBlob produces null", async () => {
    HTMLCanvasElement.prototype.toBlob = vi.fn(function toBlob(
      callback: BlobCallback,
    ) {
      callback(null);
    }) as unknown as typeof HTMLCanvasElement.prototype.toBlob;

    await expect(
      getCroppedBlob("data:image/png;base64,abc", AREA),
    ).rejects.toThrow(/canvas\.toBlob produced null/i);
  });

  it("rejects when the source image fails to load", async () => {
    vi.stubGlobal(
      "Image",
      class {
        onerror: ((event: Event) => void) | null = null;
        addEventListener(event: string, cb: (event: Event) => void) {
          if (event === "error") this.onerror = cb;
        }
        set src(_value: string) {
          // Real DOM invokes the "error" listener WITH an ErrorEvent — the
          // implementation rejects with that event, so the fake must pass one
          // or the rejection value is undefined and toBeDefined() fails.
          queueMicrotask(() => this.onerror?.(new Event("error")));
        }
      },
    );

    await expect(
      getCroppedBlob("data:image/png;base64,bad", AREA),
    ).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// uploadAvatarBlob
// ---------------------------------------------------------------------------

describe("uploadAvatarBlob", () => {
  const blob = new Blob(["fake-image-bytes"], { type: "image/webp" });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the CDN URL on a successful upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: "https://cdn.example.com/a.webp" }),
      }),
    );

    await expect(uploadAvatarBlob(blob)).resolves.toBe(
      "https://cdn.example.com/a.webp",
    );
  });

  it("POSTs to /api/v1/upload/avatar with a multipart form", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://cdn.example.com/a.webp" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await uploadAvatarBlob(blob);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/upload/avatar",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
  });

  it("throws the server's error message on a failed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "Bad image" }),
      }),
    );

    await expect(uploadAvatarBlob(blob)).rejects.toThrow("Bad image");
  });

  it("throws a generic status message when the server omits an error field", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );

    await expect(uploadAvatarBlob(blob)).rejects.toThrow(
      /Upload failed \(500\)/,
    );
  });

  it("throws when the server reports success but returns no url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );

    await expect(uploadAvatarBlob(blob)).rejects.toThrow(
      /Server returned no URL/i,
    );
  });
});

// ---------------------------------------------------------------------------
// CropSurface
// ---------------------------------------------------------------------------

describe("CropSurface", () => {
  it("renders the cropper, zoom slider, and no error by default", () => {
    render(
      <CropSurface
        imageSrc="data:image/png;base64,abc"
        shape="circle"
        crop={{ x: 0, y: 0 }}
        zoom={1}
        uploading={false}
        error={null}
        onCropChange={vi.fn()}
        onZoomChange={vi.fn()}
        onCropComplete={vi.fn()}
      />,
    );

    expect(screen.getByTestId("cropper")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Zoom" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the error message inside an alert when present", () => {
    render(
      <CropSurface
        imageSrc="data:image/png;base64,abc"
        shape="square"
        crop={{ x: 0, y: 0 }}
        zoom={1}
        uploading={false}
        error="Upload failed"
        onCropChange={vi.fn()}
        onZoomChange={vi.fn()}
        onCropComplete={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Upload failed");
  });

  it("disables the zoom slider while uploading", () => {
    render(
      <CropSurface
        imageSrc="data:image/png;base64,abc"
        shape="circle"
        crop={{ x: 0, y: 0 }}
        zoom={1}
        uploading
        error={null}
        onCropChange={vi.fn()}
        onZoomChange={vi.fn()}
        onCropComplete={vi.fn()}
      />,
    );

    expect(screen.getByRole("slider", { name: "Zoom" })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// useCropUpload
// ---------------------------------------------------------------------------

/** Minimal harness exposing every useCropUpload field/handler as clickable buttons. */
function CropUploadHarness({
  onUploaded,
}: {
  onUploaded: (url: string) => void;
}) {
  const cropUpload = useCropUpload({ onUploaded });

  return (
    <div>
      <span data-testid="has-image">{String(cropUpload.hasImage)}</span>
      <span data-testid="can-save">{String(cropUpload.canSave)}</span>
      <span data-testid="uploading">{String(cropUpload.uploading)}</span>
      <span data-testid="error">{cropUpload.error ?? ""}</span>
      <input
        data-testid="file-input"
        type="file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) cropUpload.loadFile(file);
        }}
      />
      <button
        type="button"
        data-testid="complete-crop"
        onClick={() => cropUpload.onCropComplete(AREA, AREA)}
      >
        Complete crop
      </button>
      <button
        type="button"
        data-testid="save"
        onClick={() => void cropUpload.save()}
      >
        Save
      </button>
      <button
        type="button"
        data-testid="reset"
        onClick={() => cropUpload.reset()}
      >
        Reset
      </button>
    </div>
  );
}

describe("useCropUpload", () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let originalToBlob: typeof HTMLCanvasElement.prototype.toBlob;

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    originalToBlob = HTMLCanvasElement.prototype.toBlob;

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      drawImage: vi.fn(),
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = vi.fn(function toBlob(
      callback: BlobCallback,
    ) {
      callback(new Blob(["fake"], { type: "image/webp" }));
    }) as unknown as typeof HTMLCanvasElement.prototype.toBlob;

    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        private _src = "";
        addEventListener(event: string, cb: () => void) {
          if (event === "load") this.onload = cb;
        }
        set src(value: string) {
          this._src = value;
          queueMicrotask(() => this.onload?.());
        }
        get src() {
          return this._src;
        }
      },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: "https://cdn.example.com/cropped.webp" }),
      }),
    );
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
    vi.unstubAllGlobals();
  });

  it("starts with no image and cannot save", () => {
    render(<CropUploadHarness onUploaded={vi.fn()} />);
    expect(screen.getByTestId("has-image")).toHaveTextContent("false");
    expect(screen.getByTestId("can-save")).toHaveTextContent("false");
  });

  it("sets hasImage after a file is loaded", async () => {
    render(<CropUploadHarness onUploaded={vi.fn()} />);
    const file = new File(["fake-bytes"], "photo.png", { type: "image/png" });

    await act(async () => {
      const input = screen.getByTestId("file-input") as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() =>
      expect(screen.getByTestId("has-image")).toHaveTextContent("true"),
    );
  });

  it("sets canSave once a crop region is reported", async () => {
    render(<CropUploadHarness onUploaded={vi.fn()} />);
    const file = new File(["fake-bytes"], "photo.png", { type: "image/png" });

    await act(async () => {
      const input = screen.getByTestId("file-input") as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("has-image")).toHaveTextContent("true"),
    );

    await act(async () => {
      screen.getByTestId("complete-crop").click();
    });

    expect(screen.getByTestId("can-save")).toHaveTextContent("true");
  });

  it("calls onUploaded with the resulting URL after save()", async () => {
    const onUploaded = vi.fn();
    render(<CropUploadHarness onUploaded={onUploaded} />);
    const file = new File(["fake-bytes"], "photo.png", { type: "image/png" });

    await act(async () => {
      const input = screen.getByTestId("file-input") as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("has-image")).toHaveTextContent("true"),
    );

    await act(async () => {
      screen.getByTestId("complete-crop").click();
    });

    await act(async () => {
      screen.getByTestId("save").click();
    });

    await waitFor(() =>
      expect(onUploaded).toHaveBeenCalledWith(
        "https://cdn.example.com/cropped.webp",
      ),
    );
  });

  it("surfaces an error message and does not call onUploaded when the upload fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Server exploded" }),
      }),
    );
    const onUploaded = vi.fn();
    render(<CropUploadHarness onUploaded={onUploaded} />);
    const file = new File(["fake-bytes"], "photo.png", { type: "image/png" });

    await act(async () => {
      const input = screen.getByTestId("file-input") as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("has-image")).toHaveTextContent("true"),
    );

    await act(async () => {
      screen.getByTestId("complete-crop").click();
    });
    await act(async () => {
      screen.getByTestId("save").click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("Server exploded"),
    );
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("reset() clears image, error, and canSave", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Server exploded" }),
      }),
    );
    render(<CropUploadHarness onUploaded={vi.fn()} />);
    const file = new File(["fake-bytes"], "photo.png", { type: "image/png" });

    await act(async () => {
      const input = screen.getByTestId("file-input") as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("has-image")).toHaveTextContent("true"),
    );
    await act(async () => {
      screen.getByTestId("complete-crop").click();
    });
    await act(async () => {
      screen.getByTestId("save").click();
    });
    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("Server exploded"),
    );

    await act(async () => {
      screen.getByTestId("reset").click();
    });

    expect(screen.getByTestId("has-image")).toHaveTextContent("false");
    expect(screen.getByTestId("can-save")).toHaveTextContent("false");
    expect(screen.getByTestId("error")).toHaveTextContent("");
  });
});
