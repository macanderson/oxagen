"use client";

/**
 * ConversationExportMenu — a small icon button that exports the active
 * conversation as Markdown (client-side blob download) or as a formatted PDF
 * (rendered server-side by the conversation.export capability, opened via its
 * access-controlled serve URL).
 *
 * Standalone and self-contained: the host surface (chat header/toolbar) mounts
 * it with the conversation's ids; it fetches
 * GET /api/v1/conversations/[conversationId]/export?format=markdown|pdf.
 *
 * Responsive:
 *   ≥768px — coss Menu popover anchored to the trigger button.
 *   <768px — bottom Sheet with ≥44px touch rows (thumb-navigable, mobile-first).
 */

import * as React from "react";
import { Download, FileText, FileDown, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "@/components/ui/menu";
import {
  Sheet,
  SheetTrigger,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";

export interface ConversationExportMenuProps {
  /** Public id ("cnv_…") of the conversation to export. */
  conversationId: string;
  /** Optional title, used only for accessible labels. */
  conversationTitle?: string;
  /** Org slug of the active scope (reserved for future deep links). */
  orgSlug: string;
  /** Workspace slug of the active scope (reserved for future deep links). */
  workspaceSlug: string;
}

type ExportFormat = "markdown" | "pdf";

interface ExportResponse {
  format: ExportFormat;
  filename: string;
  content: string | null;
  url: string | null;
  messageCount: number;
}

/**
 * Local matchMedia hook (no shared use-is-mobile hook exists yet — keep this
 * inline rather than minting a new shared file from a leaf component).
 */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState(false);
  React.useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return isMobile;
}

/** Trigger a client-side download of `content` as a text/markdown file. */
function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ConversationExportMenu({
  conversationId,
  conversationTitle,
}: ConversationExportMenuProps) {
  const isMobile = useIsMobile();
  const { add: toast } = useToast();
  const [exporting, setExporting] = React.useState<ExportFormat | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const runExport = React.useCallback(
    async (format: ExportFormat) => {
      setExporting(format);
      try {
        const res = await fetch(
          `/api/v1/conversations/${encodeURIComponent(conversationId)}/export?format=${format}`,
        );
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "Conversation not found"
              : `Export failed (${res.status})`,
          );
        }
        const data = (await res.json()) as ExportResponse;
        if (format === "markdown") {
          if (typeof data.content !== "string") {
            throw new Error("Export returned no content");
          }
          downloadMarkdown(data.content, data.filename);
        } else {
          if (typeof data.url !== "string") {
            throw new Error("Export returned no file URL");
          }
          window.open(data.url, "_blank", "noopener,noreferrer");
        }
      } catch (err) {
        toast({
          title: "Export failed",
          description: err instanceof Error ? err.message : "Please try again.",
          type: "error",
        });
      } finally {
        setExporting(null);
        setSheetOpen(false);
      }
    },
    [conversationId, toast],
  );

  const triggerLabel = conversationTitle
    ? `Export conversation "${conversationTitle}"`
    : "Export conversation";

  const triggerIcon = exporting ? (
    <LoaderCircle aria-hidden className="size-4 animate-spin" />
  ) : (
    <Download aria-hidden className="size-4" />
  );

  const markdownRow = (
    <>
      {exporting === "markdown" ? (
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
      ) : (
        <FileText aria-hidden className="size-4" />
      )}
      Export as Markdown
    </>
  );
  const pdfRow = (
    <>
      {exporting === "pdf" ? (
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
      ) : (
        <FileDown aria-hidden className="size-4" />
      )}
      Export as PDF
    </>
  );

  if (isMobile) {
    return (
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={triggerLabel}
              disabled={exporting !== null}
            />
          }
        >
          {triggerIcon}
        </SheetTrigger>
        <SheetPopup side="bottom" className="rounded-t-lg pb-8">
          <SheetHeader>
            <SheetTitle>Export conversation</SheetTitle>
          </SheetHeader>
          <div className="mt-2 flex flex-col gap-1">
            <button
              type="button"
              className="flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent disabled:opacity-50"
              disabled={exporting !== null}
              onClick={() => void runExport("markdown")}
            >
              {markdownRow}
            </button>
            <button
              type="button"
              className="flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent disabled:opacity-50"
              disabled={exporting !== null}
              onClick={() => void runExport("pdf")}
            >
              {pdfRow}
            </button>
          </div>
        </SheetPopup>
      </Sheet>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={triggerLabel}
            disabled={exporting !== null}
          />
        }
      >
        {triggerIcon}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem
          disabled={exporting !== null}
          onClick={() => void runExport("markdown")}
        >
          {markdownRow}
        </MenuItem>
        <MenuItem
          disabled={exporting !== null}
          onClick={() => void runExport("pdf")}
        >
          {pdfRow}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
