"use client";
import * as React from "react";
import { Server } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetPanel,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-media-query";
import type { McpServerSummary } from "./mcp-types";

function HealthDot({ status }: { status: McpServerSummary["healthStatus"] }) {
  return (
    <span
      aria-label={`Health: ${status}`}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        status === "healthy" && "bg-success",
        status === "degraded" && "bg-warning",
        status === "unreachable" && "bg-error",
      )}
    />
  );
}

export interface McpServerPickerProps {
  servers: McpServerSummary[];
  activeServerIds: Set<string>;
  onActiveServerIdsChange: (ids: Set<string>) => void;
}

export function McpServerPicker({
  servers,
  activeServerIds,
  onActiveServerIdsChange,
}: McpServerPickerProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // Close on click-outside — desktop anchored panel only. The mobile bottom
  // sheet is a Base UI dialog and handles its own dismissal (backdrop/Esc).
  React.useEffect(() => {
    if (!open || isMobile) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open, isMobile]);

  const activeCount = activeServerIds.size;
  const allActive = servers.length > 0 && activeCount === servers.length;

  function toggleServer(publicId: string, checked: boolean) {
    const next = new Set(activeServerIds);
    if (checked) {
      next.add(publicId);
    } else {
      next.delete(publicId);
    }
    onActiveServerIdsChange(next);
  }

  function activateAll() {
    onActiveServerIdsChange(new Set(servers.map((s) => s.publicId)));
  }

  function deactivateAll() {
    onActiveServerIdsChange(new Set());
  }

  const toggleAllButton = (
    <button
      type="button"
      onClick={allActive ? deactivateAll : activateAll}
      className="text-xs text-primary hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {allActive ? "Deactivate all" : "Activate all"}
    </button>
  );

  // Shared server list — rendered in the desktop anchored panel AND the
  // mobile bottom sheet. Rows get a ≥44px touch target on phones.
  const serverList =
    servers.length === 0 ? (
      <p className="text-xs text-muted-foreground">No MCP servers installed.</p>
    ) : (
      <ul className="flex flex-col gap-2">
        {servers.map((server) => {
          const isActive = activeServerIds.has(server.publicId);
          const switchId = `mcp-switch-${server.publicId}`;
          return (
            <li
              key={server.publicId}
              className={cn("flex items-center gap-2", isMobile && "min-h-11")}
            >
              <Switch
                id={switchId}
                checked={isActive}
                onCheckedChange={(checked) =>
                  toggleServer(server.publicId, checked)
                }
                disabled={server.healthStatus === "unreachable"}
                aria-label={`${isActive ? "Deactivate" : "Activate"} ${server.name}`}
              />
              <label
                htmlFor={switchId}
                className="flex flex-1 cursor-pointer items-center gap-1.5 text-sm"
              >
                <span className="flex-1 truncate">{server.name}</span>
                <HealthDot status={server.healthStatus} />
              </label>
              {server.toolCount > 0 && (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {server.toolCount}t
                </span>
              )}
            </li>
          );
        })}
      </ul>
    );

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={
          activeCount > 0
            ? `MCP servers — ${activeCount} active`
            : "MCP servers"
        }
        aria-expanded={open}
        data-testid="mcp-server-picker-btn"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "p-0",
          isMobile ? "h-11 w-11" : "h-8 w-8",
          activeCount > 0 &&
            "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
        )}
      >
        <Server className="h-4 w-4" />
        {activeCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
            {activeCount}
          </span>
        )}
      </Button>

      {isMobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetPopup
            side="bottom"
            aria-label="MCP server activation"
            data-testid="mcp-server-picker-sheet"
            className="max-h-[70vh] rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="mb-2">
              <SheetTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                MCP Servers
              </SheetTitle>
              <SheetDescription className="sr-only">
                Activate MCP servers for this turn.
              </SheetDescription>
            </SheetHeader>
            <div className="mb-2 flex justify-end">{toggleAllButton}</div>
            <SheetPanel>{serverList}</SheetPanel>
          </SheetPopup>
        </Sheet>
      ) : (
        open && (
          <div
            role="dialog"
            aria-label="MCP server activation"
            // Clamped to the viewport so a narrow window never clips the panel.
            className="absolute bottom-full left-0 mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-3 shadow-md"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                MCP Servers
              </span>
              <div className="flex gap-1">{toggleAllButton}</div>
            </div>
            {serverList}
          </div>
        )
      )}
    </div>
  );
}
