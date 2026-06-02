"use client";
/**
 * AskBar — topbar input that routes queries by intent.
 *
 * Behaviours:
 *   "/" keypress anywhere on the page → focuses this input.
 *   Enter → classifies intent, routes accordingly.
 *   Cmd+K / clicking the expand chevron → opens CommandMenu.
 *
 * The bar is a controlled input; on Enter it dispatches intent via
 * classifyIntent and:
 *   - "navigate"  → router.push(href) + clear
 *   - "fill"      → calls fillFormAction + opens FillOverlay
 *   - "search"    → opens CommandMenu with the query pre-filled
 *   - "action"    → opens CommandMenu in action mode
 *   - "ask"       → opens AskDrawer with query as seed text, then clear
 *
 * Keyboard affordances:
 *   "/"     → focus (global shortcut via keydown on document)
 *   Escape  → blur + clear
 *   Cmd+K   → open CommandMenu
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Command } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/lib/page-context";
import { classifyIntent } from "@/lib/command-menu/intent-router";
import { useRecent } from "@/lib/command-menu/use-recent";
import { fillFormAction } from "@/lib/ask/fill-action";
import type { ScopeContext } from "@/lib/scope";

export interface AskBarProps {
  /** Required so intent routing can enumerate nav targets for this scope. */
  ctx: ScopeContext;
  className?: string;
}

export function AskBar({ ctx, className }: AskBarProps) {
  const router = useRouter();
  const pageCtx = usePageContext();
  const { push: pushRecent } = useRecent();

  const [value, setValue] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Stable refs for use inside event handlers that capture stale closures.
  const pageCtxRef = React.useRef(pageCtx);
  const ctxRef = React.useRef(ctx);
  const pushRecentRef = React.useRef(pushRecent);
  const routerRef = React.useRef(router);
  React.useEffect(() => { pageCtxRef.current = pageCtx; }, [pageCtx]);
  React.useEffect(() => { ctxRef.current = ctx; }, [ctx]);
  React.useEffect(() => { pushRecentRef.current = pushRecent; }, [pushRecent]);
  React.useEffect(() => { routerRef.current = router; }, [router]);

  // Global "/" shortcut — focus the bar.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || target.isContentEditable) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Global Cmd+K shortcut — open CommandMenu.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        pageCtxRef.current.openCommand();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const handleSubmit = React.useCallback(async (query: string) => {
    if (!query) return;

    const pc = pageCtxRef.current;
    const c = ctxRef.current;

    const intent = classifyIntent({
      query,
      ctx: c,
      hasFillableForm: pc.fillableForm !== null,
    });

    pushRecentRef.current(query);

    switch (intent.type) {
      case "navigate":
        setValue("");
        routerRef.current.push(intent.href);
        return;

      case "fill": {
        const form = pc.fillableForm;
        if (!form) {
          pc.openAsk();
          return;
        }
        setIsLoading(true);
        try {
          pc._setIsFilling(true);
          const result = await fillFormAction({
            spec: {
              formId: form.formId,
              title: form.title,
              fields: form.fields,
            },
            instruction: query,
            context: {
              orgSlug: c.orgSlug,
              workspaceSlug: c.workspaceSlug,
              route: typeof window !== "undefined" ? window.location.pathname : "",
              entitySummary: pc.entity?.summary,
            },
          });
          pc._setFillResult(result);
        } finally {
          setIsLoading(false);
          pc._setIsFilling(false);
        }
        setValue("");
        return;
      }

      case "search":
      case "action":
        pc.openCommand();
        return;

      case "ask":
      default:
        setValue("");
        pc.openAsk();
        return;
    }
  }, []);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setValue("");
        inputRef.current?.blur();
        return;
      }
      if (e.key === "Enter") {
        const v = (e.currentTarget as HTMLInputElement).value.trim();
        if (v) {
          e.preventDefault();
          void handleSubmit(v);
        }
      }
    },
    [handleSubmit],
  );

  const isMac = typeof navigator !== "undefined" && (navigator.userAgentData?.platform ?? navigator.platform ?? "").toLowerCase().includes("mac");
  const kbdHint = isMac ? "⌘K" : "Ctrl+K";

  return (
    <div
      className={cn(
        "relative flex h-9 items-center",
        "w-full sm:w-64 md:w-80 lg:w-96",
        className,
      )}
    >
      {/* Search icon */}
      <Search
        className={cn(
          "pointer-events-none absolute left-2.5 h-3.5 w-3.5 shrink-0",
          "text-muted-foreground transition-colors",
          value && "text-foreground/60",
        )}
        aria-hidden="true"
      />

      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Ask, navigate, or search"
        aria-controls="cmd-listbox"
        aria-expanded={false}
        aria-haspopup="dialog"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask anything… Press / to focus"
        disabled={isLoading}
        className={cn(
          "h-full w-full rounded-md",
          "pl-8 pr-[4.5rem] text-sm",
          "border border-input bg-background shadow-sm",
          "text-foreground placeholder:text-muted-foreground",
          "outline-none transition-colors",
          "focus:ring-1 focus:ring-ring",
          "disabled:cursor-wait disabled:opacity-60",
        )}
      />

      {/* Right-side affordances */}
      <div className="pointer-events-none absolute right-1.5 flex items-center gap-1">
        {!value && (
          <kbd
            aria-hidden="true"
            className={cn(
              "hidden sm:inline-flex items-center gap-0.5 rounded-md",
              "border border-border/60 bg-muted/60 px-1.5 py-0.5",
              "font-mono text-[10px] text-muted-foreground/70",
            )}
          >
            {kbdHint}
          </kbd>
        )}
        <button
          type="button"
          aria-label="Open command menu"
          onClick={() => pageCtxRef.current.openCommand()}
          className={cn(
            "pointer-events-auto flex h-6 w-6 items-center justify-center rounded-lg",
            "text-muted-foreground/60 transition-colors hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <Command className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
