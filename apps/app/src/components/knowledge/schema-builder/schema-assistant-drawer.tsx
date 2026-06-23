"use client";

import * as React from "react";
import { Send } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TenantSlugs } from "./types";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface SchemaAssistantDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slugs: TenantSlugs;
}

export function SchemaAssistantDrawer({
  open,
  onOpenChange,
  slugs,
}: SchemaAssistantDrawerProps) {
  const [prompt, setPrompt] = React.useState("");
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  React.useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    const text = prompt.trim();
    if (!text || streaming) return;
    setPrompt("");

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);

    const assistantMsg: Message = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);

    try {
      const res = await fetch("/api/v1/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgSlug: slugs.orgSlug,
          workspaceSlug: slugs.workspaceSlug,
          message: text,
          schemaContext: true,
        }),
      });

      if (!res.ok || !res.body) {
        const errText = `Stream error (${res.status})`;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, content: errText };
          }
          return next;
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const raw = line.slice(6).trim();
            if (raw === "[DONE]") break;
            try {
              const parsed = JSON.parse(raw) as { type?: string; text?: string; content?: string };
              if (parsed.type === "component") {
                // Render component events as JSON dump for now
                accumulated += `\n[component: ${JSON.stringify(parsed)}]\n`;
              } else {
                const delta = parsed.text ?? parsed.content ?? "";
                accumulated += delta;
              }
            } catch {
              accumulated += raw;
            }
          }
        }
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, content: accumulated };
          }
          return next;
        });
      }
    } catch (e) {
      const errText = e instanceof Error ? e.message : "Unknown error";
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = { ...last, content: `Error: ${errText}` };
        }
        return next;
      });
    } finally {
      setStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col w-[500px] max-w-full p-0">
        <SheetHeader className="px-4 py-4 border-b border-border">
          <SheetTitle>Schema Assistant</SheetTitle>
        </SheetHeader>
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full py-16 text-center">
              <p className="text-sm text-muted-foreground">
                Ask the AI to help design your schema — add labels, suggest properties, or explain
                relationship types.
              </p>
            </div>
          )}
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={cn(
                "rounded-xl px-4 py-3 text-sm",
                msg.role === "user"
                  ? "bg-primary text-primary-foreground ml-8"
                  : "bg-muted text-muted-foreground mr-8",
              )}
            >
              {msg.content || (streaming && msg.role === "assistant" ? "…" : "")}
            </div>
          ))}
        </div>
        <div className="px-4 py-4 border-t border-border space-y-2">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask the AI about your schema… (Ctrl+Enter to send)"
            rows={3}
            className="resize-none"
            disabled={streaming}
          />
          <div className="flex justify-end">
            <Button
              onClick={() => void handleSend()}
              disabled={streaming || !prompt.trim()}
              className="gap-1.5"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
