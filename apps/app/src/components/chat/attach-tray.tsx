"use client";

import * as React from "react";
import { Camera, FileText, Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetPanel,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

/**
 * AttachTray — chat_ux_v2 mobile only. The condensed composer row's plus
 * button opens this bottom sheet instead of firing a single file picker
 * directly (see message-composer.tsx), so a phone user gets a camera vs
 * library vs document choice with ≥44px rows.
 *
 * The row set is driven by what `/api/v1/upload/attachment` actually accepts
 * (packages/storage/src/assets.ts `ASSET_ALLOWED_TYPES`):
 *   - image    — webp/png/jpeg/gif, 5 MiB
 *   - video    — mp4/webm/quicktime, 100 MiB
 *   - document — the same image types plus application/pdf, 25 MiB
 * "Choose files" is scoped to `application/pdf` only — the one type
 * "document" adds beyond what "Choose photos" already covers, so the two
 * rows never overlap or lie about what they accept.
 *
 * There is deliberately NO "Record voice" row: the server has no "audio"
 * asset kind at all (only avatar/image/document/video — see
 * packages/storage/src/assets.ts), so every audio upload would 415. Shipping
 * the row would be dead UI.
 */
export function AttachTray({
  open,
  onOpenChange,
  onCapturePhoto,
  onPickPhotos,
  onPickDocuments,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A single camera-captured photo (`accept="image/*"`, `capture="environment"`). */
  onCapturePhoto: (files: FileList) => void;
  /** Library picks — images and videos, matching the legacy paperclip picker. */
  onPickPhotos: (files: FileList) => void;
  /** Document picks — PDF only. */
  onPickDocuments: (files: FileList) => void;
}) {
  const cameraInputRef = React.useRef<HTMLInputElement>(null);
  const photosInputRef = React.useRef<HTMLInputElement>(null);
  const documentsInputRef = React.useRef<HTMLInputElement>(null);

  function handlePicked(
    e: React.ChangeEvent<HTMLInputElement>,
    onPicked: (files: FileList) => void,
  ) {
    // A cancelled native picker fires onChange with an empty FileList in some
    // environments — only dispatch + close on an actual selection, so
    // dismissing the OS dialog never silently closes the tray underneath it.
    if (e.target.files && e.target.files.length > 0) {
      onPicked(e.target.files);
      onOpenChange(false);
    }
    // Reset so picking the SAME file again still fires onChange.
    e.target.value = "";
  }

  return (
    <>
      {/* Hidden native inputs — one per row, each with an `accept` matching
        what the server will actually take. */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => handlePicked(e, onCapturePhoto)}
      />
      <input
        ref={photosInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => handlePicked(e, onPickPhotos)}
      />
      <input
        ref={documentsInputRef}
        type="file"
        accept="application/pdf"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => handlePicked(e, onPickDocuments)}
      />
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetPopup
          side="bottom"
          data-testid="attach-tray"
          className="rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="mb-2">
            <SheetTitle className="text-sm">Add attachment</SheetTitle>
            <SheetDescription className="sr-only">
              Choose what to attach to this message.
            </SheetDescription>
          </SheetHeader>
          <SheetPanel className="gap-1">
            <Button
              type="button"
              variant="ghost"
              aria-label="Take photo"
              onClick={() => cameraInputRef.current?.click()}
              className="h-11 w-full justify-start gap-2 px-2 text-sm"
            >
              <Camera className="h-4 w-4" aria-hidden="true" />
              Take photo
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-label="Choose photos"
              onClick={() => photosInputRef.current?.click()}
              className="h-11 w-full justify-start gap-2 px-2 text-sm"
            >
              <ImageIcon className="h-4 w-4" aria-hidden="true" />
              Choose photos
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-label="Choose files"
              onClick={() => documentsInputRef.current?.click()}
              className="h-11 w-full justify-start gap-2 px-2 text-sm"
            >
              <FileText className="h-4 w-4" aria-hidden="true" />
              Choose files
            </Button>
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </>
  );
}
