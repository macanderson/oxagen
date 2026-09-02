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
import { schemaChat, applyMutation } from "./schema-service";
import type { TenantSlugs } from "./types";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface SchemaAssistantDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slugs: TenantSlugs;
  onApplied?: () => void;
}

export function SchemaAssistantDrawer({
  open,
  onOpenChange,
  slugs,
  onApplied,
}: SchemaAssistantDrawerProps) {
  const [prompt, setPrompt] = React.useState("");
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [loading, setLoading] = React.useState(false);
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
    if (!text || loading) return;
    setPrompt("");

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      // Call schema.chat handler — returns assistantMessage + optional proposedMutations
      const result = await schemaChat(slugs, text);

      // Append the assistant's explanation
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.assistantMessage },
      ]);

      // Apply proposed mutations sequentially
      const mutations = result.proposedMutations ?? [];
      if (mutations.length > 0) {
        const successes: string[] = [];
        const failures: string[] = [];

        for (const mutation of mutations) {
          try {
            await applyMutation(slugs, mutation.capability, mutation.input);
            successes.push(mutation.capability);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failures.push(`${mutation.capability}: ${msg}`);
          }
        }

        // Build a summary message
        const lines: string[] = [];
        if (successes.length > 0) {
          lines.push(
            `Applied ${successes.length} mutation(s): ${successes.join(", ")}.`,
          );
        }
        if (failures.length > 0) {
          lines.push(
            `Failed ${failures.length} mutation(s): ${failures.join("; ")}.`,
          );
        }
        if (lines.length > 0) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: lines.join("\n") },
          ]);
        }

        // Notify the builder to re-fetch if at least one mutation succeeded
        if (successes.length > 0) {
          onApplied?.();
        }
      }
    } catch (e) {
      const errText = e instanceof Error ? e.message : "Unknown error";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${errText}` },
      ]);
    } finally {
      setLoading(false);
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
      <SheetContent
        side="right"
        className="flex flex-col w-[500px] max-w-full p-0"
      >
        <SheetHeader className="px-4 py-4 border-b border-border">
          <SheetTitle>Schema Assistant</SheetTitle>
        </SheetHeader>
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
        >
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full py-16 text-center">
              <p className="text-sm text-muted-foreground">
                Ask the AI to help design your schema — add labels, suggest
                properties, or explain relationship types.
              </p>
            </div>
          )}
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={cn(
                "rounded-xl px-4 py-3 text-sm whitespace-pre-wrap",
                msg.role === "user"
                  ? "bg-primary text-primary-foreground ml-8"
                  : "bg-muted text-muted-foreground mr-8",
              )}
            >
              {msg.content || (loading && msg.role === "assistant" ? "…" : "")}
            </div>
          ))}
          {loading && (
            <div className="rounded-xl px-4 py-3 text-sm bg-muted text-muted-foreground mr-8 animate-pulse">
              Thinking…
            </div>
          )}
        </div>
        <div className="px-4 py-4 border-t border-border space-y-2">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask the AI about your schema… (Ctrl+Enter to send)"
            rows={3}
            className="resize-none"
            disabled={loading}
          />
          <div className="flex justify-end">
            <Button
              onClick={() => void handleSend()}
              disabled={loading || !prompt.trim()}
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
