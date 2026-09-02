"use client";

/**
 * make-video-form — renders the make-a-video request form in chat.
 *
 * This component is rendered inside the chat message bubble whenever the
 * video.generate capability returns a render directive with componentId
 * "make-video-form". It is pre-populated with the prompt and options the
 * agent already inferred, letting the user review, edit, and submit.
 *
 * The submit handler calls a "use server" action (videoGenerateAction) that
 * invokes the real video.generate capability: it creates a pending
 * generated_assets row and dispatches the async Inngest render worker
 * (agent.video-render), returning a typed { queued: true, jobId } result.
 *
 * Note on RSC: this is a client component with a bound server action, which is
 * the only shape allowed here. `ai/rsc` (streamUI / createStreamableUI /
 * createAI) is banned platform-wide — generative UI arrives as `generateObject`
 * structured output and is mapped to a React component by this registry, never
 * as a server-rendered React tree. Do not "upgrade" this form to streamUI.
 */

import * as React from "react";
import { Film, Clock, LayoutTemplate, Wand2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectPopup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { videoGenerateAction } from "@/app/actions/video.generate.action";
import { cn } from "@/lib/utils";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface MakeVideoFormProps {
  /** Pre-populated prompt text for the video */
  prompt?: string;
  /** Optional aspect ratio (e.g. "16:9", "9:16", "1:1") */
  aspectRatio?: string;
  /** Optional duration in seconds */
  durationSeconds?: number;
  /** Optional style hint (e.g. "cinematic", "animated") */
  style?: string;
  /**
   * Org slug from the current URL route segment. Required so the server
   * action can resolve real org + workspace context for the IAM check.
   * Injected by the stream route into the render directive props.
   */
  orgSlug?: string;
  /**
   * Workspace slug from the current URL route segment. Required so the server
   * action can resolve real org + workspace context for the IAM check.
   * Injected by the stream route into the render directive props.
   */
  workspaceSlug?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

type FormState = "idle" | "submitting" | "queued" | "error";

export default function MakeVideoForm({
  prompt: initialPrompt = "",
  aspectRatio: initialAspectRatio,
  durationSeconds: initialDurationSeconds,
  style: initialStyle = "",
  orgSlug = "",
  workspaceSlug = "",
}: MakeVideoFormProps): React.ReactElement {
  const [prompt, setPrompt] = React.useState(initialPrompt);
  const [aspectRatio, setAspectRatio] = React.useState<string>(
    initialAspectRatio ?? "16:9",
  );
  const [durationSeconds, setDurationSeconds] = React.useState<string>(
    initialDurationSeconds !== undefined
      ? String(initialDurationSeconds)
      : "10",
  );
  const [style, setStyle] = React.useState(initialStyle);
  const [formState, setFormState] = React.useState<FormState>("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [jobId, setJobId] = React.useState<string | null>(null);

  const promptId = React.useId();
  const durationId = React.useId();
  const aspectRatioId = React.useId();
  const styleId = React.useId();

  const isSubmitting = formState === "submitting";
  const isQueued = formState === "queued";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormState("submitting");
    setErrorMessage(null);

    const parsedDuration = parseInt(durationSeconds, 10);
    const result = await videoGenerateAction({
      prompt,
      durationSeconds: Number.isFinite(parsedDuration)
        ? parsedDuration
        : undefined,
      aspectRatio: aspectRatio as "16:9" | "9:16" | "1:1",
      style: style.trim() !== "" ? style.trim() : undefined,
      orgSlug,
      workspaceSlug,
    });

    if (result.ok) {
      setJobId(result.jobId);
      setFormState("queued");
    } else {
      setErrorMessage(result.error);
      setFormState("error");
    }
  }

  // ── Queued state ─────────────────────────────────────────────────────────────

  if (isQueued) {
    return (
      <div
        className={cn(
          "rounded-2xl border border-border bg-card p-5",
          "space-y-3",
        )}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3">
          <CheckCircle2
            className="h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Video queued</p>
            <p className="truncate text-xs text-muted-foreground">
              Job{jobId ? ` · ${jobId}` : ""} — rendering now, this can take a
              few minutes
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground italic">
          &ldquo;{prompt}&rdquo;
        </p>
      </div>
    );
  }

  // ── Form ─────────────────────────────────────────────────────────────────────

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Generate video"
      className={cn(
        "rounded-2xl border border-border bg-card p-5",
        "space-y-5",
      )}
    >
      {/* Header row */}
      <div className="flex items-center gap-2.5">
        <Film
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-foreground">
          Generate video
        </span>
        <span className="ml-auto text-xs font-medium text-muted-foreground">
          Preview
        </span>
      </div>

      {/* Prompt */}
      <div className="space-y-1.5">
        <Label htmlFor={promptId}>Prompt</Label>
        <Textarea
          id={promptId}
          name="prompt"
          placeholder="Describe the video you want to generate…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
          minLength={1}
          rows={3}
          disabled={isSubmitting}
          aria-required="true"
          className="resize-none"
        />
      </div>

      {/* Duration + Aspect ratio row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Duration */}
        <div className="space-y-1.5">
          <Label htmlFor={durationId} className="flex items-center gap-1.5">
            <Clock
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            Duration (seconds)
          </Label>
          <Input
            id={durationId}
            name="durationSeconds"
            type="number"
            min={1}
            max={60}
            step={1}
            value={durationSeconds}
            onChange={(e) => setDurationSeconds(e.target.value)}
            disabled={isSubmitting}
            aria-label="Duration in seconds"
          />
        </div>

        {/* Aspect ratio */}
        <div className="space-y-1.5">
          <Label htmlFor={aspectRatioId} className="flex items-center gap-1.5">
            <LayoutTemplate
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            Aspect ratio
          </Label>
          <Select
            value={aspectRatio}
            onValueChange={(v) => {
              if (v !== null) setAspectRatio(v);
            }}
            disabled={isSubmitting}
            name="aspectRatio"
          >
            <SelectTrigger
              id={aspectRatioId}
              aria-label="Aspect ratio"
              aria-controls={`${aspectRatioId}-listbox`}
              aria-expanded={false}
            >
              <SelectValue placeholder="Select ratio" />
            </SelectTrigger>
            <SelectPopup id={`${aspectRatioId}-listbox`}>
              <SelectItem value="16:9">16:9 — Landscape</SelectItem>
              <SelectItem value="9:16">9:16 — Portrait</SelectItem>
              <SelectItem value="1:1">1:1 — Square</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      </div>

      {/* Style */}
      <div className="space-y-1.5">
        <Label htmlFor={styleId} className="flex items-center gap-1.5">
          <Wand2
            className="h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          Style
          <span className="ml-1 font-normal text-muted-foreground">
            (optional)
          </span>
        </Label>
        <Input
          id={styleId}
          name="style"
          type="text"
          placeholder="e.g. cinematic, animated, lo-fi…"
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          disabled={isSubmitting}
          autoComplete="off"
        />
      </div>

      {/* Error */}
      {formState === "error" && errorMessage !== null && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </p>
      )}

      {/* Submit */}
      <Button
        type="submit"
        disabled={isSubmitting || prompt.trim() === ""}
        className="w-full"
        aria-busy={isSubmitting}
      >
        {isSubmitting ? "Queueing…" : "Generate video"}
      </Button>
    </form>
  );
}
