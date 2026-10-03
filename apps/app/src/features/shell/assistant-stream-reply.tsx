"use client";
// The two states of a streamed reply the flyout draws beside a finished one
// (ADR-176): a reply the engine is still writing, and a reply whose stream
// dropped before it finished.
//
// A reply in progress is painted as its text arrives. The transcript is a
// `role="log"` live region, and text that grows on every fragment would be
// read out as fragments, so the growing copy is `aria-hidden` and `inert`. The
// spinner's label says a turn is running. The finished reply replaces this
// copy as a new entry, and the region announces it whole, once.
//
// A dropped stream keeps what arrived. The turn itself runs on and saves its
// reply with the run (ADR-092), so the person can load the finished reply
// instead of asking again. A stream that dropped before it named its run has
// nothing to load by, so it offers to ask again.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { AssistantMarkdown } from "./assistant-markdown";

/** A tool call the turn is making, or has made. */
export type StreamedTool = {
  id: string;
  capability: string;
  status: "running" | "completed" | "failed";
};

/** Where a dropped reply's load stands. */
export type DroppedLoad = "idle" | "loading" | "running" | "ended" | "unread";

export function AssistantAnswering({
  text,
  tools,
}: {
  text: string;
  tools: readonly StreamedTool[];
}) {
  const t = useTranslations("shell.assistant.answering");
  const running = tools.filter((tool) => tool.status === "running");
  return (
    <div data-testid="assistant-answering" aria-hidden="true" inert>
      {text === "" ? null : (
        <AssistantMarkdown streaming>{text}</AssistantMarkdown>
      )}
      {running.map((tool) => (
        <p
          key={tool.id}
          data-testid="assistant-tool-running"
          className="mt-1 font-mono text-[11px] text-muted-foreground"
        >
          {t("tool", { capability: tool.capability })}
        </p>
      ))}
    </div>
  );
}

export function AssistantDropped({
  text,
  runId,
  load,
  org,
  ws,
  retryDisabled,
  onLoad,
  onRetry,
}: {
  /** What arrived before the stream dropped. */
  text: string;
  /** The run the stream named; null when it dropped before naming one. */
  runId: string | null;
  load: DroppedLoad;
  /** The workspace the question was asked in. */
  org: string;
  ws: string;
  retryDisabled: boolean;
  onLoad: () => void;
  onRetry: () => void;
}) {
  const t = useTranslations("shell.assistant");
  return (
    <div data-testid="assistant-dropped">
      {text === "" ? null : <AssistantMarkdown>{text}</AssistantMarkdown>}
      <p
        data-testid="assistant-dropped-note"
        className="mt-1.5 rounded-md border border-border px-2 py-1.5 text-[12px] text-muted-foreground"
      >
        {runId === null ? t("dropped.noRun") : t("dropped.body")}
      </p>
      {runId === null ? (
        <button
          type="button"
          data-testid="assistant-retry"
          disabled={retryDisabled}
          onClick={onRetry}
          className={`mt-1.5 text-[12px] ${linkText} disabled:opacity-60`}
        >
          {t("retry")}
        </button>
      ) : (
        <>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {t("recordedAs")}{" "}
            <SafeLink
              to={routes.run(org, ws, runId)}
              data-testid="assistant-dropped-run"
              className={linkText}
            >
              {runId}
            </SafeLink>
          </p>
          <DroppedLoadLine load={load} />
          {load === "ended" ? null : (
            <button
              type="button"
              data-testid="assistant-load-reply"
              disabled={load === "loading"}
              aria-busy={load === "loading" || undefined}
              onClick={onLoad}
              className={`mt-1.5 text-[12px] ${linkText} disabled:opacity-60`}
            >
              {load === "loading" ? t("dropped.loading") : t("dropped.load")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** What the last load found, spelled out key by key for the catalog walk. */
function DroppedLoadLine({ load }: { load: DroppedLoad }) {
  const t = useTranslations("shell.assistant.dropped");
  const line =
    load === "running"
      ? t("running")
      : load === "ended"
        ? t("ended")
        : load === "unread"
          ? t("unread")
          : null;
  return line === null ? null : (
    <p
      data-testid={`assistant-dropped-${load}`}
      className="mt-1 text-[12px] text-muted-foreground"
    >
      {line}
    </p>
  );
}
