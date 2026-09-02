"use client";
import * as React from "react";
import NextImage from "next/image";
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
import { CropSurface, useCropUpload } from "./crop-upload";

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

  // Crop/upload state machine shared with the avatar maker's Photo tab.
  const cropUpload = useCropUpload({
    onUploaded: (url) => {
      onChange(url);
      handleOpenChange(false);
    },
  });

  // Hidden file input ref — triggered by the visible button.
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Per-instance id. A page can render more than one AvatarUpload (user avatar
  // + org avatar on the same settings form), and a hard-coded id would make
  // both labels point at whichever input mounted first.
  const fileInputId = React.useId();

  /** Called whenever the Dialog closes (X button, Escape, or Cancel). */
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) cropUpload.reset();
      setOpen(nextOpen);
    },
    [cropUpload],
  );

  /** Called when the user picks a file from the OS file-picker. */
  const handleFileChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input value so the same file can be re-selected after cancel.
      e.target.value = "";
      if (!file) return;

      cropUpload.loadFile(file);
      setOpen(true);
    },
    [cropUpload],
  );

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
          <NextImage
            src={value!}
            alt="Avatar"
            width={64}
            height={64}
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
        <Label htmlFor={fileInputId} className="sr-only">
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
          id={fileInputId}
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
            {cropUpload.imageSrc ? (
              <CropSurface
                imageSrc={cropUpload.imageSrc}
                shape={shape}
                crop={cropUpload.crop}
                zoom={cropUpload.zoom}
                uploading={cropUpload.uploading}
                error={cropUpload.error}
                onCropChange={cropUpload.setCrop}
                onZoomChange={cropUpload.setZoom}
                onCropComplete={cropUpload.onCropComplete}
              />
            ) : (
              // The cropper needs a source. When the read failed there isn't
              // one, so the reason has to surface here or the dialog is blank.
              <p className="text-sm text-destructive" role="alert">
                {cropUpload.error ?? "Loading photo…"}
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
                  disabled={cropUpload.uploading}
                />
              }
            >
              Cancel
            </DialogClose>

            {/* Save — disabled while uploading or before crop area is set */}
            <Button
              size="lg"
              disabled={cropUpload.uploading || !cropUpload.canSave}
              onClick={() => void cropUpload.save()}
            >
              {cropUpload.uploading ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
