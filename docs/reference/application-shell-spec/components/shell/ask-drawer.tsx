"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ExternalLink, Sparkles, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { PromptInput } from "./prompt-input"
import { useShell } from "./shell-context"

type Msg = { role: "user" | "assistant"; text: string }

export function AskDrawer() {
  const { askOpen, askEntity, closeAsk } = useShell()
  const router = useRouter()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)

  // Seed a message when opened with an entity / query.
  useEffect(() => {
    if (askOpen && askEntity && messages.length === 0) {
      setMessages([
        { role: "user", text: askEntity },
        {
          role: "assistant",
          text: "Here's what I found based on the current context. This is a mock response demonstrating the persistent Ask drawer — it stays open as you navigate between pages.",
        },
      ])
    }
  }, [askOpen, askEntity, messages.length])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages])

  function send(text: string, suffix?: string) {
    if (!text.trim()) return
    setMessages((m) => [
      ...m,
      { role: "user", text: suffix ? `${text} ${suffix}` : text },
      {
        role: "assistant",
        text: "Mock answer: in a real build this streams from the selected model with the current page entity attached as context.",
      },
    ])
  }

  return (
    <>
      {/* Scrim */}
      <div
        aria-hidden="true"
        onClick={closeAsk}
        className={cn(
          "fixed inset-0 z-40 bg-foreground/20 transition-opacity duration-200",
          askOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        aria-label="Ask"
        aria-hidden={!askOpen}
        inert={!askOpen ? true : undefined}
        className={cn(
          "fixed right-0 top-0 z-50 flex h-dvh w-full flex-col border-l border-border bg-card shadow-xl transition-transform duration-200 will-change-transform sm:w-[480px]",
          askOpen ? "translate-x-0" : "pointer-events-none translate-x-full",
        )}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Sparkles className="size-4 text-brand" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Ask</h2>
          {askEntity && (
            <Badge variant="secondary" className="max-w-[180px] truncate text-xs">
              {askEntity}
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Pop out to full page"
              onClick={() => {
                closeAsk()
                router.push("/ask")
              }}
            >
              <ExternalLink className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Close Ask drawer"
              onClick={closeAsk}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Sparkles className="size-8 opacity-40" aria-hidden="true" />
              <p className="text-sm">Ask about anything in this workspace.</p>
              <p className="text-xs">The current page&apos;s primary entity is attached as context.</p>
            </div>
          ) : (
            messages.map((m, i) => (
              <div
                key={i}
                className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed",
                    m.role === "user"
                      ? "bg-brand text-brand-foreground"
                      : "bg-muted text-foreground",
                  )}
                >
                  {m.text}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-border p-3">
          <PromptInput
            compact
            value={input}
            onChange={setInput}
            placeholder="Reply…"
            onSubmit={(payload) => {
              const suffix =
                payload.intent === "image"
                  ? "(generate image)"
                  : payload.intent === "video"
                    ? "(generate video)"
                    : undefined
              send(payload.text, suffix)
            }}
          />
        </div>
      </aside>
    </>
  )
}
