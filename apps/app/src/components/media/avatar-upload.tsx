"use client";
import * as React from "react";
import Cropper, { type Area } from "react-easy-crop";
// react-easy-crop v5 ships its overlay/handle styles separately — without this
// the crop area renders unstyled (no mask, no drag handles).
import "react-easy-crop/react-easy-crop.css";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AvatarUploadProps {
  /** Current avatar URL (may be null/empty). Shown as the preview. */
  value: string | null | undefined;
  /** Called with the uploaded CDN URL after a successful crop+upload. */
  onChange: (url: string) => void;
  /** Fallback initials shown when there is no image (e.g. user/org name initial). */
  fallback?: string;
  /** Visual shape of the preview + crop area. Default "circle". */
  shape?: "circle" | "square";
  /** Disabled state (e.g. while a parent form is submitting). */
  disabled?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Canvas helper — crops `imageSrc` to the pixel region `area` and returns a
// 512×512 WebP Blob. Factored here so it can be tree-shaken if only the types
// are imported elsewhere, and to keep the component render surface lean.
// ---------------------------------------------------------------------------

async function getCroppedBlob(imageSrc: string, area: Area): Promise<Blob> {
  // Load the source image off-screen so we can measure its natural dimensions.
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => resolve(img));
    img.addEventListener("error", reject);
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
    area.x,      // source x
    area.y,      // source y
    area.width,  // source width
    area.height, // source height
    0,           // dest x
    0,           // dest y
    512,         // dest width
    512,         // dest height
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AvatarUpload({
  value,
  onChange,
  fallback,
  shape = "circle",
  disabled = false,
  className,
}: AvatarUploadProps): React.JSX.Element {
  // Controlled open state so we can reset transient state on close.
  const [open, setOpen] = React.useState(false);

  // The data-URL of the file the user selected, kept as the Cropper source.
  const [imageSrc, setImageSrc] = React.useState<string | null>(null);

  // Cropper state: position, zoom, and the final pixel crop region.
  const [crop, setCrop] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = React.useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = React.useState<Area | null>(null);

  // Upload lifecycle.
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Hidden file input ref — triggered by the visible button.
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Reset all transient dialog state (crop, zoom, imageSrc, error). */
  const resetTransient = React.useCallback(() => {
    if (imageSrc) URL.revokeObjectURL(imageSrc);
    setImageSrc(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);
    setError(null);
    setUploading(false);
  }, [imageSrc]);

  /** Called whenever the Dialog closes (X button, Escape, or Cancel). */
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) resetTransient();
      setOpen(nextOpen);
    },
    [resetTransient],
  );

  /** Called when the user picks a file from the OS file-picker. */
  const handleFileChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input value so the same file can be re-selected after cancel.
      e.target.value = "";
      if (!file) return;

      // Revoke any previous object URL to avoid memory leaks.
      if (imageSrc) URL.revokeObjectURL(imageSrc);

      const reader = new FileReader();
      reader.addEventListener("load", () => {
        setImageSrc(reader.result as string);
        setError(null);
        setOpen(true);
      });
      reader.readAsDataURL(file);
    },
    [imageSrc],
  );

  /** POSTs the cropped blob to the upload endpoint and calls `onChange`. */
  const handleSave = React.useCallback(async () => {
    if (!imageSrc || !croppedAreaPixels) return;

    setUploading(true);
    setError(null);

    try {
      const blob = await getCroppedBlob(imageSrc, croppedAreaPixels);

      const fd = new FormData();
      fd.append("file", blob, "avatar.webp");

      const res = await fetch("/api/v1/upload/avatar", {
        method: "POST",
        body: fd,
      });

      // Parse response body regardless of status so we can surface server
      // error messages in the dialog rather than throwing generically.
      const json = (await res.json()) as { url?: string; error?: string };

      if (!res.ok) {
        throw new Error(json.error ?? `Upload failed (${res.status})`);
      }

      if (!json.url) throw new Error("Server returned no URL");

      onChange(json.url);
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [imageSrc, croppedAreaPixels, onChange, handleOpenChange]);

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const isCircle = shape === "circle";
  const hasImage = Boolean(value);

  // Shape classes applied to both the preview element and the fallback badge.
  const shapeClass = isCircle ? "rounded-full" : "rounded-md";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className={cn("flex items-center gap-4", className)}>
      {/* Preview / fallback badge — 64×64 */}
      <div
        className={cn(
          "flex size-16 shrink-0 items-center justify-center overflow-hidden bg-muted ring-1 ring-border",
          shapeClass,
        )}
        aria-hidden="true"
      >
        {hasImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value!}
            alt="Avatar"
            className="size-full object-cover"
          />
        ) : (
          <span className="text-lg font-semibold uppercase text-muted-foreground">
            {fallback?.charAt(0) ?? <Upload className="size-5" />}
          </span>
        )}
      </div>

      {/* Visible trigger — opens the file picker, not the dialog directly.
          The dialog opens only after a valid file is chosen so the Cropper
          always has an imageSrc to display. */}
      <div className="flex flex-col gap-1.5">
        {/*
          Accessible label wired to the hidden input; the visible Button is a
          presentational trigger that forwards the click to the real input.
        */}
        <Label htmlFor="avatar-file-input" className="sr-only">
          {hasImage ? "Change photo" : "Upload photo"}
        </Label>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          aria-label={hasImage ? "Change avatar photo" : "Upload avatar photo"}
        >
          {hasImage ? "Change photo" : "Upload photo"}
        </Button>
        <input
          ref={fileInputRef}
          id="avatar-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          disabled={disabled}
          onChange={handleFileChange}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>

      {/* Crop dialog — controlled; only rendered when a file has been chosen. */}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Crop photo</DialogTitle>
          </DialogHeader>

          <DialogPanel className="gap-4">
            {/* Cropper container — fixed height so the canvas has stable geometry */}
            <div
              className={cn(
                "relative h-72 w-full overflow-hidden bg-black",
                isCircle ? "rounded-full" : "rounded-md",
              )}
            >
              {imageSrc && (
                <Cropper
                  image={imageSrc}
                  crop={crop}
                  zoom={zoom}
                  aspect={1}
                  cropShape={isCircle ? "round" : "rect"}
                  showGrid={false}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={(_: Area, areaPixels: Area) => {
                    setCroppedAreaPixels(areaPixels);
                  }}
                />
              )}
            </div>

            {/* Zoom slider */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="avatar-zoom-slider">
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
                onChange={(e) => setZoom(Number(e.target.value))}
                className="w-full accent-primary"
                disabled={uploading}
              />
            </div>

            {/* Inline error — shown inside the dialog, not as a toast, so the
                user can retry without re-selecting the file. */}
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </DialogPanel>

          <DialogFooter>
            {/* Cancel — DialogClose handles the onOpenChange(false) cascade */}
            <DialogClose
              render={
                <Button
                  variant="outline"
                  size="lg"
                  disabled={uploading}
                />
              }
            >
              Cancel
            </DialogClose>

            {/* Save — disabled while uploading or before crop area is set */}
            <Button
              size="lg"
              disabled={uploading || !croppedAreaPixels}
              onClick={() => void handleSave()}
            >
              {uploading ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
