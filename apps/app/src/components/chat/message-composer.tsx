"use client";
import * as React from "react";
import { Brain, ImageIcon, Send, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  supportsReasoning,
  getModel,
} from "@oxagen/ai/catalog";
import type { ResolvedTierCatalog, EffortLevel } from "@oxagen/ai/catalog";
import {
  ModelPicker,
  defaultModelState,
  type ComposerModelState,
} from "./model-picker";

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
  modelConfig,
}: {
  conversationId: string | null;
  parentMessageId: string | null;
  action: ComposerAction;
  disabled?: boolean;
  disabledReason?: string;
  modelConfig: ResolvedTierCatalog;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [model, setModel] = React.useState<ComposerModelState>(defaultModelState);
  const formRef = React.useRef<HTMLFormElement>(null);

  // Resolve which text model is active (for reasoning capability check).
  const resolvedTextModelId =
    model.generate === null
      ? (model.model ?? modelConfig.text[model.tier ?? "fast"])
      : null;
  const resolvedTextModel =
    resolvedTextModelId !== null ? getModel(resolvedTextModelId) : undefined;
  const showEffortControl =
    model.generate === null && supportsReasoning(resolvedTextModel);

  // Placeholder text varies by media mode.
  const placeholder =
    disabled
      ? (disabledReason ?? "Composer paused.")
      : model.generate === "image"
        ? "Describe the image you want…"
        : model.generate === "video"
          ? "Describe the video you want…"
          : "Send a message…";

  function toggleGenerate(kind: "image" | "video") {
    if (model.generate === kind) {
      // Toggle off — return to text defaults.
      setModel((s) => ({ ...s, generate: null }));
    } else {
      // Toggle on — switch to this kind with media defaults.
      setModel((s) => ({
        ...s,
        generate: kind,
        mediaTier: "basic",
        mediaModel: null,
      }));
    }
  }

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (disabled) return;
    setError(null);
    const fd = new FormData(e.currentTarget);
    if (conversationId) fd.set("conversationId", conversationId);
    if (parentMessageId) fd.set("parentMessageId", parentMessageId);

    // Append model-selection fields to FormData.
    if (model.generate === null) {
      // Text mode: tier OR explicit model (never both).
      if (model.model) {
        fd.set("model", model.model);
      } else {
        fd.set("tier", model.tier ?? "fast");
      }
      // Effort only when the resolved model supports reasoning.
      if (showEffortControl && model.effort) {
        fd.set("effort", model.effort);
      }
    } else {
      // Media generation mode.
      fd.set("generate", model.generate);
      if (model.mediaModel) {
        fd.set("mediaModel", model.mediaModel);
      } else {
        fd.set("mediaTier", model.mediaTier ?? "basic");
      }
    }

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
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring"
    >
      <Textarea
        name="content"
        required
        placeholder={placeholder}
        rows={3}
        disabled={pending || disabled}
        className="border-none bg-transparent shadow-none focus-visible:ring-0"
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {disabled && disabledReason ? (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}

      {/* Toolbar */}
      <div className="flex items-center gap-1">
        {/* Model picker */}
        <ModelPicker value={model} onChange={setModel} modelConfig={modelConfig} />

        {/* Reasoning effort — only when the resolved model supports it */}
        {showEffortControl && (
          <Select
            value={model.effort ?? "medium"}
            onValueChange={(v) => setModel((s) => ({ ...s, effort: v as EffortLevel }))}
          >
            <SelectTrigger
              size="sm"
              className="h-8 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs font-medium shadow-none hover:bg-muted focus:ring-0"
              aria-label={`Reasoning effort: ${model.effort ?? "medium"}`}
            >
              <Brain className="h-3.5 w-3.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="low">Low effort</SelectItem>
              <SelectItem value="medium">Medium effort</SelectItem>
              <SelectItem value="high">High effort</SelectItem>
            </SelectPopup>
          </Select>
        )}

        {/* Image generation toggle */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Generate image"
          aria-pressed={model.generate === "image"}
          onClick={() => toggleGenerate("image")}
          className={cn(
            "h-8 w-8 p-0",
            model.generate === "image" && "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
          )}
        >
          <ImageIcon className="h-4 w-4" />
        </Button>

        {/* Video generation toggle */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Generate video"
          aria-pressed={model.generate === "video"}
          onClick={() => toggleGenerate("video")}
          className={cn(
            "h-8 w-8 p-0",
            model.generate === "video" && "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
          )}
        >
          <Video className="h-4 w-4" />
        </Button>

        <div className="ml-auto">
          <Button type="submit" disabled={pending || disabled} size="sm">
            <Send className="h-3.5 w-3.5" />
            {pending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </form>
  );
}
