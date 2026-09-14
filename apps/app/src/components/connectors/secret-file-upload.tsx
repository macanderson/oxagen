"use client";

/**
 * secret-file-upload.tsx — File upload widget for secret files (e.g. service account JSON).
 *
 * Accepts JSON files, base64-encodes the content for storage.
 * Shows file name after upload with a clear button to reset.
 */

import * as React from "react";
import { Upload, X, FileJson } from "lucide-react";
import { cn } from "@oxagen/ui";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SecretFileUploadProps {
  value?: string; // base64-encoded file content
  onChange: (value: string | undefined) => void;
  accept?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SecretFileUpload({
  value,
  onChange,
  accept = "application/json,.json",
  label = "Upload JSON file",
  disabled = false,
  className,
  id,
}: SecretFileUploadProps) {
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dropRef = React.useRef<HTMLDivElement>(null);

  const processFile = React.useCallback(
    (file: File) => {
      setError(null);

      if (!file.type.includes("json") && !file.name.endsWith(".json")) {
        setError("Only JSON files are supported");
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result;
        if (typeof result !== "string") {
          setError("Failed to read file");
          return;
        }
        // Strip the data URL prefix (data:application/json;base64,...)
        const base64 = result.includes(",")
          ? (result.split(",")[1] ?? result)
          : result;
        setFileName(file.name);
        onChange(base64);
      };
      reader.onerror = () => setError("Failed to read file");
      reader.readAsDataURL(file);
    },
    [onChange],
  );

  const handleFileChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.currentTarget.files?.[0];
      if (file) processFile(file);
      // Reset input so the same file can be re-selected after clearing
      e.currentTarget.value = "";
    },
    [processFile],
  );

  const handleClear = React.useCallback(() => {
    setFileName(null);
    setError(null);
    onChange(undefined);
  }, [onChange]);

  // Drag-and-drop support
  const handleDrop = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handleDragOver = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
    },
    [],
  );

  const hasFile = Boolean(value) || Boolean(fileName);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {hasFile ? (
        /* Uploaded state */
        <div className="flex items-center gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
          <FileJson
            className="h-4 w-4 shrink-0 text-success"
            aria-hidden="true"
          />
          <span className="flex-1 truncate text-sm text-foreground">
            {fileName ?? "Uploaded file"}
          </span>
          <button
            type="button"
            onClick={handleClear}
            disabled={disabled}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
            aria-label="Clear uploaded file"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : (
        /* Drop zone */
        <div
          ref={dropRef}
          id={id}
          role="button"
          tabIndex={disabled ? -1 : 0}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => !disabled && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (!disabled && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 bg-muted/20 px-4 py-6 text-center cursor-pointer transition-colors",
            "hover:border-border hover:bg-muted/40",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            disabled && "opacity-50 pointer-events-none",
          )}
          aria-label={label}
        >
          <Upload
            className="h-5 w-5 text-muted-foreground"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">
              JSON files only. Drag &amp; drop or click.
            </p>
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={handleFileChange}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
      />

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
