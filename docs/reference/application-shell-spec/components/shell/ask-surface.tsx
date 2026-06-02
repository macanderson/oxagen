"use client"

import { useState } from "react"
import { MessageSquarePlus, Sparkles } from "lucide-react"
import { motion } from "framer-motion"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { PromptInput } from "./prompt-input"
import { OxagenLogomark } from "./oxagen-logo"

const conversations = [
  { id: "c1", title: "Why did run #4221 fail?", time: "2m" },
  { id: "c2", title: "Draft churn-investigate playbook", time: "1h" },
  { id: "c3", title: "Summarize last week's incidents", time: "Yesterday" },
  { id: "c4", title: "Which agents touched the billing graph?", time: "2d" },
]

export function AskSurface({ workspaceName }: { workspaceName: string }) {
  const [active, setActive] = useState(conversations[0].id)
  const [input, setInput] = useState("")

  return (
    <div className="flex h-[calc(100dvh-3.5rem)]">
      {/* Conversation list */}
      <div className="hidden w-72 shrink-0 flex-col border-r border-border md:flex">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Conversations</h2>
          <Button variant="ghost" size="icon" className="size-7" aria-label="New conversation">
            <MessageSquarePlus className="size-4" />
          </Button>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setActive(c.id)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  c.id === active ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <span className="line-clamp-1 font-medium">{c.title}</span>
                <span className="text-xs text-muted-foreground">{c.time} ago</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Chat panel */}
      <div className="flex min-w-0 flex-1 flex-col">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
        >
          <motion.span
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.3, ease: "easeOut" }}
            className="glass-strong gradient-ring grid size-14 place-items-center rounded-2xl"
          >
            <OxagenLogomark className="size-8 text-foreground" />
          </motion.span>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.3 }}
          >
            <h1 className="text-xl font-semibold tracking-tight">Ask {workspaceName}</h1>
            <p className="mt-2 max-w-md text-pretty text-sm text-muted-foreground">
              The chat front door for this workspace. Ask questions, run actions, or navigate — the
              workspace context is always attached.
            </p>
          </motion.div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.4 }}
          className="mx-auto w-full max-w-2xl px-4 pb-6"
        >
          <PromptInput
            value={input}
            onChange={setInput}
            placeholder={`Ask anything about ${workspaceName}…`}
            onSubmit={(payload) => {
              console.log("[v0] prompt submit:", payload)
            }}
          />
        </motion.div>
      </div>
    </div>
  )
}
