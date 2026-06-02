"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowRight, Compass, MessageCircleQuestion, Search, Sparkles, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ScopeContext, ShellMode } from "@/lib/scope"
import { sidebarRegistry } from "@/lib/sidebar"
import { destinations } from "@/lib/destinations"
import { Kbd } from "@/components/ui/kbd"
import { useShell } from "./shell-context"

type Candidate = { label: string; href: string; hint: string }

type Intent = "navigate" | "search" | "action" | "ask"

function buildCandidates(mode: Exclude<ShellMode, "pre-shell">, scope: ScopeContext): Candidate[] {
  const config = sidebarRegistry[mode]
  const items: Candidate[] = []
  for (const item of config.items) {
    if (item.isReturn) continue
    const href = item.href(scope)
    items.push({ label: item.label, href, hint: config.groupLabel ?? "" })
    const dest = destinations[item.id]
    if (dest) {
      for (const tab of dest.tabs) {
        items.push({
          label: `${item.label} · ${tab.label}`,
          href: `${href}/${tab.slug}`,
          hint: item.label,
        })
      }
    }
  }
  return items
}

const ACTION_RE = /\b(create|invite|revoke|delete|add|new|remove|disable|enable)\b/i
const SEARCH_RE = /(run\s*#|playbook\s|token\s|@[\w.]+@|#\d+)/i

function classifyIntent(query: string, candidates: Candidate[]): Intent {
  const q = query.trim().toLowerCase()
  if (!q) return "ask"
  if (q.startsWith("go to ") || candidates.some((c) => c.label.toLowerCase() === q)) return "navigate"
  if (ACTION_RE.test(q)) return "action"
  if (SEARCH_RE.test(query)) return "search"
  if (q.endsWith("?")) return "ask"
  // single/double word that matches a destination prefix → navigate
  if (candidates.some((c) => c.label.toLowerCase().includes(q)) && q.split(" ").length <= 2)
    return "navigate"
  return "ask"
}

const intentMeta: Record<Intent, { icon: typeof Zap; label: string }> = {
  navigate: { icon: Compass, label: "Navigate" },
  search: { icon: Search, label: "Search" },
  action: { icon: Zap, label: "Action" },
  ask: { icon: MessageCircleQuestion, label: "Ask" },
}

export function AskBar({
  mode,
  scope,
}: {
  mode: Exclude<ShellMode, "pre-shell">
  scope: ScopeContext
}) {
  const router = useRouter()
  const { openAsk } = useShell()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)

  const candidates = useMemo(() => buildCandidates(mode, scope), [mode, scope])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^go to /, "")
    if (!q) return candidates.slice(0, 5)
    return candidates.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 6)
  }, [candidates, query])

  const intent = classifyIntent(query, candidates)

  // Global "/" to focus, Cmd/Ctrl-K to open expanded.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const typing =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
      if (e.key === "/" && !typing) {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  function runIntent(forced?: Intent) {
    const resolved = forced ?? intent
    const text = query.trim()
    if (resolved === "navigate") {
      const target = matches[activeIdx] ?? matches[0]
      if (target) {
        router.push(target.href)
      }
    } else if (resolved === "ask") {
      openAsk(text || null)
    } else if (resolved === "action") {
      openAsk(`Action: ${text}`)
    } else if (resolved === "search") {
      openAsk(`Search: ${text}`)
    }
    setQuery("")
    setOpen(false)
    inputRef.current?.blur()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setQuery("")
      setOpen(false)
      inputRef.current?.blur()
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)))
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    }
    if (e.key === "Enter") {
      e.preventDefault()
      runIntent()
    }
  }

  const IntentIcon = intentMeta[intent].icon

  return (
    <div className="relative w-full max-w-xl">
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm transition-shadow",
          open && "ring-2 ring-ring",
        )}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls="ask-suggestions"
      >
        <Sparkles className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            setActiveIdx(0)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          aria-label="Ask anything — navigate, search, run an action, or chat"
          placeholder="Ask anything…"
          className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        {!query && (
          <Kbd className="hidden sm:inline-flex" aria-hidden="true">
            /
          </Kbd>
        )}
      </div>

      {open && (
        <div
          id="ask-suggestions"
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <IntentIcon className="size-3.5" aria-hidden="true" />
            <span>
              Intent: <span className="font-medium text-foreground">{intentMeta[intent].label}</span>
            </span>
            <span className="ml-auto hidden items-center gap-1 sm:flex">
              <Kbd>↵</Kbd> to run
            </span>
          </div>

          {(intent === "navigate" || !query) && matches.length > 0 && (
            <div className="max-h-64 overflow-y-auto py-1">
              {matches.map((m, i) => (
                <button
                  key={m.href}
                  role="option"
                  aria-selected={i === activeIdx}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => runIntent("navigate")}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                    i === activeIdx ? "bg-muted text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Compass className="size-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate text-foreground">{m.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{m.hint}</span>
                  <ArrowRight className="size-3.5 shrink-0 opacity-0 [button[aria-selected=true]_&]:opacity-100" />
                </button>
              ))}
            </div>
          )}

          {query && intent !== "navigate" && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runIntent()}
              className="flex w-full items-center gap-2 px-3 py-3 text-left text-sm hover:bg-muted"
            >
              <IntentIcon className="size-4 shrink-0 text-brand" aria-hidden="true" />
              <span className="flex-1 truncate">
                {intentMeta[intent].label} <span className="text-foreground">“{query}”</span>
              </span>
              <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
