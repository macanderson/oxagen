"use client";

import * as React from "react";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverClose,
  PopoverPopup,
} from "@/components/ui/popover";

/**
 * AttachPopover — chat_ux_v2 desktop only. Wraps the condensed composer
 * row's plus button so it opens a small anchored popover instead of firing
 * the file picker directly. Mobile gets the fuller AttachTray bottom sheet
 * (a popover on a touch surface is the one thing the v2 design rules ban
 * outright — see message-composer.tsx's `v2Mobile`/`v2Desktop` split).
 *
 * Only one row — "Upload files" — spanning every kind
 * `/api/v1/upload/attachment` accepts (image, video, document — see
 * packages/storage/src/assets.ts `ASSET_ALLOWED_TYPES`). There is
 * deliberately no "Record voice" row: the server has no "audio" asset kind
 * at all, so every audio upload would 415 — shipping the row would be dead
 * UI.
 */
export function AttachPopover({
  disabled = false,
  onPickFiles,
}: {
  disabled?: boolean;
  /**
   * Fires with every picked file. The composer classifies each by MIME type
   * (image / video / application/pdf) and uploads it with the matching
   * server kind — see `addClassifiedFiles` in message-composer.tsx.
   */
  onPickFiles: (files: FileList) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Add attachment"
            disabled={disabled}
            className="h-11 w-11 shrink-0 p-0"
          />
        }
      >
        <Paperclip className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        data-testid="attach-popover"
        className="w-48 p-1"
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*,application/pdf"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0)
              onPickFiles(e.target.files);
            // Reset so picking the SAME file again still fires onChange.
            e.target.value = "";
          }}
        />
        <PopoverClose
          render={
            <Button
              type="button"
              variant="ghost"
              aria-label="Upload files"
              onClick={() => inputRef.current?.click()}
              className="h-11 w-full justify-start gap-2 px-2 text-sm"
            />
          }
        >
          <Paperclip className="h-4 w-4" aria-hidden="true" />
          Upload files
        </PopoverClose>
      </PopoverPopup>
    </Popover>
  );
}
