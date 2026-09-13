"use client";
/**
 * crop-upload.tsx — the shared photo crop + upload internals behind every
 * avatar photo flow in the app.
 *
 * Extracted from `avatar-upload.tsx` so both the standalone `AvatarUpload`
 * component and the Photo tab of `AvatarMaker` (`../avatar/avatar-maker.tsx`)
 * share one implementation of "pick a file, crop it to a 512×512 WebP, POST
 * it to /api/v1/upload/avatar, hand back the CDN URL" rather than forking the
 * canvas/upload logic in two places.
 */
import * as React from "react";
import Cropper, { type Area } from "react-easy-crop";
// react-easy-crop v5 ships its overlay/handle styles separately — without this
// the crop area renders unstyled (no mask, no drag handles).
import "react-easy-crop/react-easy-crop.css";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Crops `imageSrc` to the pixel region `area` and returns a 512×512 WebP
 * Blob. Pure/DOM-only (canvas + Image), no component state.
 */
export async function getCroppedBlob(
  imageSrc: string,
  area: Area,
): Promise<Blob> {
  // Load the source image off-screen so we can measure its natural dimensions.
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => resolve(img));
    // Reject with a real Error, never the raw event — an ErrorEvent (or nothing,
    // in some environments) as a rejection reason gives callers no message/stack.
    img.addEventListener("error", () =>
      reject(new Error("failed to load source image for cropping")),
    );
    img.src = imageSrc;
  });

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");

  // Draw the cropped source region scaled into the 512×512 output canvas.
  ctx.drawImage(
    image,
    area.x, // source x
    area.y, // source y
    area.width, // source width
    area.height, // source height
    0, // dest x
    0, // dest y
    512, // dest width
    512, // dest height
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas.toBlob produced null"));
      },
      "image/webp",
      0.9,
    );
  });
}

/** POSTs a cropped avatar blob to the upload endpoint and returns its CDN URL. */
export async function uploadAvatarBlob(
  blob: Blob,
  filename = "avatar.webp",
): Promise<string> {
  const fd = new FormData();
  fd.append("file", blob, filename);

  const res = await fetch("/api/v1/upload/avatar", {
    method: "POST",
    body: fd,
  });

  // Parse the body regardless of status so a server-supplied message reaches
  // the caller. A proxy/gateway failure answers with HTML, not JSON, so the
  // parse itself has to be tolerated — otherwise the user sees a JSON syntax
  // error instead of "Upload failed (502)".
  let json: { url?: string; error?: string } = {};
  try {
    json = (await res.json()) as { url?: string; error?: string };
  } catch {
    if (res.ok)
      throw new Error("Upload succeeded but the response was unreadable");
  }

  if (!res.ok) {
    throw new Error(json.error ?? `Upload failed (${res.status})`);
  }
  if (!json.url) throw new Error("Server returned no URL");

  return json.url;
}

// ---------------------------------------------------------------------------
// useCropUpload — shared crop/upload state machine
// ---------------------------------------------------------------------------

export interface UseCropUploadOptions {
  /** Called with the uploaded CDN URL after a successful crop+upload. */
  onUploaded: (url: string) => void;
}

export interface UseCropUploadResult {
  /** The data-URL of the file the user selected; null before a pick. */
  imageSrc: string | null;
  crop: { x: number; y: number };
  zoom: number;
  uploading: boolean;
  error: string | null;
  /** True once a file has been picked (drives whether the cropper renders). */
  hasImage: boolean;
  /** True once a crop region is known, so Save can be enabled. */
  canSave: boolean;
  setCrop: (crop: { x: number; y: number }) => void;
  setZoom: (zoom: number) => void;
  onCropComplete: (croppedArea: Area, croppedAreaPixels: Area) => void;
  /** Loads a picked File into the cropper as its data-URL source. */
  loadFile: (file: File) => void;
  /** Crops the current image + uploads it; calls `onUploaded` on success. */
  save: () => Promise<void>;
  /** Resets all transient state (image, crop, zoom, error). */
  reset: () => void;
}

export function useCropUpload({
  onUploaded,
}: UseCropUploadOptions): UseCropUploadResult {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null);
  const [crop, setCrop] = React.useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [zoom, setZoom] = React.useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = React.useState<Area | null>(
    null,
  );
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reset = React.useCallback(() => {
    // imageSrc is always a `data:` URL from FileReader.readAsDataURL — never a
    // `blob:` object URL — so there is nothing to revoke here.
    setImageSrc(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);
    setError(null);
    setUploading(false);
  }, []);

  const loadFile = React.useCallback((file: File) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      setImageSrc(reader.result as string);
      setError(null);
    });
    // Without this the dialog opens onto a permanently empty cropper when the
    // file can't be read (removed drive, revoked permission) — no error, no
    // way for the user to tell the pick simply failed.
    reader.addEventListener("error", () => {
      setImageSrc(null);
      setError("Couldn't read that file. Pick another photo.");
    });
    reader.readAsDataURL(file);
  }, []);

  const onCropComplete = React.useCallback(
    (_croppedArea: Area, croppedAreaPixels: Area) => {
      setCroppedAreaPixels(croppedAreaPixels);
    },
    [],
  );

  const save = React.useCallback(async () => {
    if (!imageSrc || !croppedAreaPixels) return;

    setUploading(true);
    setError(null);

    try {
      const blob = await getCroppedBlob(imageSrc, croppedAreaPixels);
      const url = await uploadAvatarBlob(blob);
      onUploaded(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [imageSrc, croppedAreaPixels, onUploaded]);

  return {
    imageSrc,
    crop,
    zoom,
    uploading,
    error,
    hasImage: imageSrc !== null,
    canSave: croppedAreaPixels !== null,
    setCrop,
    setZoom,
    onCropComplete,
    loadFile,
    save,
    reset,
  };
}

// ---------------------------------------------------------------------------
// CropSurface — the shared Cropper + zoom slider + error presentational block
// ---------------------------------------------------------------------------

export interface CropSurfaceProps {
  imageSrc: string;
  shape: "circle" | "square";
  crop: { x: number; y: number };
  zoom: number;
  uploading: boolean;
  error: string | null;
  onCropChange: (crop: { x: number; y: number }) => void;
  onZoomChange: (zoom: number) => void;
  onCropComplete: (croppedArea: Area, croppedAreaPixels: Area) => void;
  className?: string;
}

/** The cropper canvas + zoom slider + inline error, shared by every crop UI. */
export function CropSurface({
  imageSrc,
  shape,
  crop,
  zoom,
  uploading,
  error,
  onCropChange,
  onZoomChange,
  onCropComplete,
  className,
}: CropSurfaceProps): React.JSX.Element {
  const isCircle = shape === "circle";

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {/* Cropper container — fixed height so the canvas has stable geometry */}
      <div
        className={cn(
          "relative h-72 w-full overflow-hidden bg-black",
          isCircle ? "rounded-full" : "rounded-md",
        )}
      >
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={1}
          cropShape={isCircle ? "round" : "rect"}
          showGrid={false}
          onCropChange={onCropChange}
          onZoomChange={onZoomChange}
          onCropComplete={onCropComplete}
        />
      </div>

      {/* Zoom slider */}
      <div className="flex flex-col gap-1.5">
        <label
          className="text-xs text-muted-foreground"
          htmlFor="avatar-zoom-slider"
        >
          Zoom
        </label>
        <input
          id="avatar-zoom-slider"
          type="range"
          aria-label="Zoom"
          min={1}
          max={3}
          step={0.05}
          value={zoom}
          onChange={(e) => onZoomChange(Number(e.target.value))}
          className="w-full accent-primary"
          disabled={uploading}
        />
      </div>

      {/* Inline error — shown inside the dialog, not as a toast, so the user
          can retry without re-selecting the file. */}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
