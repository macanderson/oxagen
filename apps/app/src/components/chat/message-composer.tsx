"use client";
import * as React from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface ComposerAction {
  (formData: FormData): Promise<{ ok: boolean; error?: string }>;
}

export function MessageComposer({
  conversationId,
  parentMessageId,
  action,
}: {
  conversationId: string | null;
  parentMessageId: string | null;
  action: ComposerAction;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    if (conversationId) fd.set("conversationId", conversationId);
    if (parentMessageId) fd.set("parentMessageId", parentMessageId);
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) {
        setError(res.error ?? "Failed to send message");
        return;
      }
      formRef.current?.reset();
    });
  };

  return (
    <form ref={formRef} onSubmit={onSubmit} className="glass-panel flex flex-col gap-2 p-3">
      <Textarea
        name="content"
        required
        placeholder="Send a message…"
        rows={3}
        disabled={pending}
        className="border-none bg-transparent shadow-none focus-visible:ring-0"
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center justify-end">
        <Button type="submit" disabled={pending} size="sm">
          <Send className="h-3.5 w-3.5" />
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
