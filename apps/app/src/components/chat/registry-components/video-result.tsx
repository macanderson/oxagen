"use client";

// video-result — renders an async-generated video once its render job lands.
//
// The chat route creates a `pending` generated_assets row and dispatches the
// `agent/video.render` Inngest job, then emits this component with the asset's
// access-controlled serving URL. The serving route returns 404 until the render
// uploads the blob and flips the row to `ready`, so we poll it and swap in a
// <video> element on the first successful response.

import * as React from "react";
import { Film, Loader2, VideoOff } from "lucide-react";

export interface VideoResultProps {
  /** Access-controlled serving URL (/api/v1/assets/gen_…). 404 until ready. */
  url: string;
  /** Original generation prompt — shown while rendering and as a caption. */
  prompt?: string;
  /** Poll interval in ms. */
  pollMs?: number;
  /**
   * Duration-adjustment notice from the handler — shown when the requested
   * length wasn't supported by the model and the render was snapped to the
   * nearest supported duration.
   */
  notice?: string;
}

type Phase = "rendering" | "ready" | "timed-out";

// Veo renders take minutes; cap the poll so a stuck job doesn't spin forever.
const DEFAULT_POLL_MS = 5000;
const MAX_ATTEMPTS = 240; // ~20 min at 5s

export default function VideoResult({
  url,
  prompt,
  pollMs = DEFAULT_POLL_MS,
  notice,
}: VideoResultProps): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>("rendering");

  // Duration-adjustment banner — rendered above every phase so the user learns
  // their requested length was snapped even while the render is still running.
  const noticeBanner = notice ? (
    <div className="border-b border-border bg-muted/40 px-4 py-2 dark:bg-muted/15">
      <p className="text-xs text-muted-foreground">{notice}</p>
    </div>
  ) : null;

  React.useEffect(() => {
    if (phase !== "rendering") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    async function poll(): Promise<void> {
      attempts += 1;
      try {
        // HEAD avoids downloading the body during polling; Next serves HEAD from
        // the GET handler automatically. A 200 means the render landed.
        const res = await fetch(url, { method: "HEAD", cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          setPhase("ready");
          return;
        }
      } catch {
        // Network blip — keep polling until the cap.
      }
      if (cancelled) return;
      if (attempts >= MAX_ATTEMPTS) {
        setPhase("timed-out");
        return;
      }
      timer = setTimeout(() => void poll(), pollMs);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [url, pollMs, phase]);

  if (phase === "ready") {
    return (
      <div
        className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-sm"
        role="figure"
        aria-label={prompt ?? "Generated video"}
      >
        {noticeBanner}
        <video
          controls
          preload="metadata"
          className="h-auto max-h-[512px] w-full bg-black"
          src={url}
        />
        {prompt && (
          <div className="border-t border-border px-4 py-2.5">
            <p className="truncate text-xs text-muted-foreground">{prompt}</p>
          </div>
        )}
      </div>
    );
  }

  if (phase === "timed-out") {
    return (
      <div
        className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-sm"
        role="status"
      >
        {noticeBanner}
        <div className="flex flex-col items-center justify-center gap-3 bg-muted/30 px-6 py-10 text-center dark:bg-muted/10">
          <div className="rounded-full bg-muted p-3">
            <VideoOff
              className="size-6 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <p className="text-sm font-medium text-foreground">
            Video is taking longer than expected
          </p>
          <p className="max-w-xs text-xs text-muted-foreground">
            The render is still running. Refresh the conversation to check
            again.
          </p>
        </div>
      </div>
    );
  }

  // rendering
  return (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-sm"
      role="status"
      aria-live="polite"
    >
      {noticeBanner}
      <div className="flex flex-col items-center justify-center gap-3 bg-muted/30 px-6 py-10 text-center dark:bg-muted/10">
        <div className="relative">
          <Film className="size-8 text-muted-foreground" aria-hidden="true" />
          <Loader2
            className="absolute -right-2 -top-2 size-4 animate-spin text-primary"
            aria-hidden="true"
          />
        </div>
        <p className="text-sm font-medium text-foreground">Generating video…</p>
        {prompt && (
          <p className="max-w-xs truncate text-xs italic text-muted-foreground">
            “{prompt}”
          </p>
        )}
      </div>
    </div>
  );
}
