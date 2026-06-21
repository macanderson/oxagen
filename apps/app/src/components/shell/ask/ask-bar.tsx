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
import { useToast } from "@/components/ui/toast";
import type { ScopeContext } from "@/lib/scope";

// Module-level stable noop — useSyncExternalStore requires a *stable* subscribe
// reference. An inline `() => () => {}` creates a new function on every render,
// causing React to re-subscribe on each pass and triggering spurious snapshot
// re-checks that accumulate into a "Maximum update depth exceeded" loop in
// strict-mode dev. Moving it outside the component gives it a permanent identity.
function _stableNoopSubscribe(_callback: () => void): () => void {
  return () => {};
}

export interface AskBarProps {
  /** Required so intent routing can enumerate nav targets for this scope. */
  ctx: ScopeContext;
  className?: string;
}

export function AskBar({ ctx, className }: AskBarProps) {
  const router = useRouter();
  const pageCtx = usePageContext();
  const { push: pushRecent } = useRecent();
  const toast = useToast();

  const [value, setValue] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Keyboard-hint symbol is platform-dependent (⌘ on macOS, Ctrl elsewhere),
  // but `navigator` is client-only. Reading it at render time made the server
  // emit "Ctrl+K" and the client "⌘K" → a hydration mismatch that crashed the
  // Base-UI shell in production. useSyncExternalStore renders the server
  // snapshot ("⌘K") on SSR + the first hydration pass (so they match — no
  // mismatch), then swaps to the real platform value on the client.
  // NOTE: subscribe is the module-level _stableNoopSubscribe — NOT an inline
  // arrow — to avoid the "Maximum update depth exceeded" loop described above.
  const kbdHint = React.useSyncExternalStore(
    _stableNoopSubscribe,
    () => {
      const platform = (navigator.userAgentData?.platform ?? navigator.platform ?? "").toLowerCase();
      return platform.includes("mac") ? "⌘K" : "Ctrl+K";
    },
    () => "⌘K",
  );

  // Stable refs for use inside event handlers that capture stale closures.
  const pageCtxRef = React.useRef(pageCtx);
  const ctxRef = React.useRef(ctx);
  const pushRecentRef = React.useRef(pushRecent);
  const routerRef = React.useRef(router);
  const toastRef = React.useRef(toast);
  React.useEffect(() => { toastRef.current = toast; }, [toast]);
  React.useEffect(() => { pageCtxRef.current = pageCtx; }, [pageCtx]);
  // Depend on primitives (orgSlug, workspaceSlug) rather than the ctx object
  // reference. ShellFrame creates a new ctx object on every re-render (e.g.
  // after the sidebar collapses from localStorage), so the object-identity dep
  // fires the effect on every shell re-render even though the values are
  // identical. Using primitives limits the effect to genuine scope changes.
  React.useEffect(() => { ctxRef.current = ctx; }, [ctx.orgSlug, ctx.workspaceSlug]); // eslint-disable-line react-hooks/exhaustive-deps
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
          // A swallowed auth/IAM/billing denial or capability error returns an
          // all-unchanged fallback carrying `error`. Surface it so the user
          // sees an actionable message instead of the overlay silently not
          // rendering (which reads as "the AI had no suggestions").
          if (result.error) {
            toastRef.current.add({
              title: "Couldn't fill the form",
              description: result.error,
              type: "error",
            });
          }
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


  return (
    <div
      className={cn(
        "relative flex h-9 w-full items-center",
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
          "h-full w-full rounded-lg",
          "pl-8 pr-[4.5rem] text-sm",
          "border border-input bg-background shadow-sm",
          "text-foreground placeholder:text-muted-foreground",
          "outline-none transition-[box-shadow,border-color]",
          "focus:border-ring focus:ring-2 focus:ring-ring/40",
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
