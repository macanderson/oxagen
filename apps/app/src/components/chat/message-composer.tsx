"use client";
import * as React from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface ComposerAction {
  (formData: FormData): Promise<{
    ok: boolean;
    error?: string;
    // sendMessageAction returns these on success so the caller can start the
    // chat stream with the persisted conversation id and the just-created
    // user-message id. Optional because other composer actions (e.g. the
    // org-shell quick-send) don't produce them.
    conversationId?: string;
    userMessageId?: string;
  }>;
}

export function MessageComposer({
  conversationId,
  parentMessageId,
  action,
  disabled = false,
  disabledReason,
}: {
  conversationId: string | null;
  parentMessageId: string | null;
  action: ComposerAction;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (disabled) return;
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
    <form ref={formRef} onSubmit={onSubmit} className="gradient-ring flex flex-col gap-2 rounded-2xl border border-border/50 bg-card p-3 text-card-foreground shadow-lg transition-shadow focus-within:ring-2 focus-within:ring-brand/30">
      <Textarea
        name="content"
        required
        placeholder={disabled ? (disabledReason ?? "Composer paused.") : "Send a message…"}
        rows={3}
        disabled={pending || disabled}
        className="border-none bg-transparent shadow-none focus-visible:ring-0"
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {disabled && disabledReason ? (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}
      <div className="flex items-center justify-end">
        <Button type="submit" disabled={pending || disabled} size="sm">
          <Send className="h-3.5 w-3.5" />
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
