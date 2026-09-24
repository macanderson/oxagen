// Two of the Run page's tabs (spec pages/run.md): Policy and Context.
//
// Policy reads the run's transcript narrowed to the policy chip, page by page
// to the end (`readWholeTranscript`), and lists the entries that carry a
// policy decision. A list that stops short of the end (`isWhole`) says it is a
// prefix; a failed read says it failed. The latency is the gap between the call's frame and the decision's, both
// recorded instants. The rules that fired and the taint are not on the
// transcript, so those cells say so.
//
// Context draws what the record holds about the model's window: the steering
// manifest a wrapped session seals at its start (a `steering.manifest` frame,
// ADR-093), and the recalls the transcript carries, read to the end the same
// way as Policy. The first request's window
// itself (the Prompt panel, the block-by-block window and the retrieval
// figures) needs USED_CONTEXT edges nothing writes yet (G10), and each panel
// says that rather than drawing an empty window.
import { useLocale, useTranslations } from "next-intl";
import {
  parseSteeringManifest,
  type RunFrameBody,
  type RunTranscript,
  type TranscriptEntry,
} from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { formatCount, formatDuration } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { NoValue, Panel } from "./parts";
import { entryKey } from "./transcript-model";
import { isWhole } from "./whole-transcript";

type Place = { org: string; ws: string; runId: string };

/** The frame type a wrapped session seals its steering manifest under. */
export const MANIFEST_FRAME = "steering.manifest";

/** The entries of a whole-run transcript that answer to one chip. */
export function entriesOf(
  read: Read<RunTranscript>,
  kind: "policy" | "recall",
): TranscriptEntry[] | null {
  return read.ok
    ? read.value.entries.filter((entry) => entry.kinds.includes(kind))
    : null;
}

/** The first frame of the whole-run read that carries the steering manifest. */
export function manifestSeq(read: Read<RunTranscript>): string | null {
  if (!read.ok) return null;
  return (
    read.value.entries.find((entry) => entry.type === MANIFEST_FRAME)?.seq ??
    null
  );
}

function FrameLink({
  seq,
  chainRef,
  place,
}: {
  seq: string;
  /** Set for a subagent's frame, which the Frames tab cannot open by seq. */
  chainRef: string | undefined;
  place: Place;
}) {
  // The Frames tab reads the run's own chain. A subagent's frame shares its
  // seq with a different frame there, so it is named and not linked.
  if (chainRef !== undefined)
    return <span className={`${mono} text-muted-foreground`}>{seq}</span>;
  return (
    <SafeLink
      to={routes.run(place.org, place.ws, place.runId, {
        tab: "actions",
        body: seq,
      })}
      className={`${mono} text-muted-foreground hover:text-foreground`}
    >
      {seq}
    </SafeLink>
  );
}

function outcomeTone(decision: string) {
  if (decision === "allow") return "allowed" as const;
  if (decision === "deny") return "denied" as const;
  if (decision === "ask" || decision === "approval") return "approval" as const;
  return "quiet" as const;
}

/** Milliseconds from the call's frame to the decision's; null when the order is not recorded. */
function latencyOf(entry: TranscriptEntry): number | null {
  if (entry.decision === null) return null;
  const gap =
    new Date(entry.decision.at).getTime() - new Date(entry.at).getTime();
  return Number.isFinite(gap) && gap >= 0 ? gap : null;
}

export function PolicySection({
  read,
  place,
}: {
  read: Read<RunTranscript>;
  place: Place;
}) {
  const t = useTranslations("run.policy");
  const locale = useLocale();
  const entries = entriesOf(read, "policy");
  if (entries === null || !read.ok) {
    return (
      <Panel title={t("title")}>
        {read.ok ? null : <ReadFailure read={read} section={t("title")} />}
      </Panel>
    );
  }
  return (
    <Panel title={t("title")}>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("frame") },
            { label: t("call") },
            { label: t("outcome") },
            { label: t("rules") },
            { label: t("taint") },
            { label: t("latency"), numeric: true },
          ]}
        >
          {entries.map((entry) => {
            const latency = latencyOf(entry);
            return (
              <tr key={entryKey(entry)}>
                <td className={cell}>
                  <FrameLink
                    seq={entry.decision?.seq ?? entry.seq}
                    chainRef={
                      entry.decision === null
                        ? entry.subagent?.chainRef
                        : entry.decision.chainRef
                    }
                    place={place}
                  />
                </td>
                <td className={`${cell} ${mono}`}>{entry.label}</td>
                <td className={cell}>
                  {entry.decision === null ? (
                    <NoValue />
                  ) : (
                    <Badge tone={outcomeTone(entry.decision.decision)}>
                      {entry.decision.decision}
                    </Badge>
                  )}
                </td>
                <td className={cell}>
                  <NoValue />
                </td>
                <td className={cell}>
                  <NoValue />
                </td>
                <td className={numericCell}>
                  {latency === null ? (
                    <NoValue />
                  ) : (
                    formatDuration(latency, locale)
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="pt-3 text-xs text-muted-foreground">{t("note")}</p>
      {isWhole(read.value) ? null : (
        <p className="pt-1 text-xs text-muted-foreground">{t("cut")}</p>
      )}
    </Panel>
  );
}

/** A panel whose store does not exist yet: its heading, and one sentence naming the gap. */
function Unrecorded({
  title,
  gap,
  children,
}: {
  title: string;
  gap: string;
  children: string;
}) {
  return (
    <Panel title={title}>
      <p
        data-testid="run-unrecorded"
        data-gap={gap}
        className="max-w-prose text-sm text-muted-foreground"
      >
        {children}
      </p>
    </Panel>
  );
}

function Manifest({
  run,
  seq,
  body,
}: {
  run: RunRow;
  /** The manifest frame's seq; null when the run sealed none. */
  seq: string | null;
  body: Read<RunFrameBody> | null;
}) {
  const t = useTranslations("run.context.manifest");
  const locale = useLocale();
  const count = (value: number) => formatCount(value, locale);
  if (seq === null || body === null) {
    return (
      <Unrecorded title={t("title")} gap="steering.manifest">
        {t("none")}
      </Unrecorded>
    );
  }
  if (!body.ok) {
    return (
      <Panel title={t("title")}>
        <ReadFailure read={body} section={t("title")} />
      </Panel>
    );
  }
  const manifest = parseSteeringManifest(body.value.text);
  if (manifest === null) {
    return (
      <Panel title={t("title")}>
        <p className="text-sm text-muted-foreground">
          {t("unreadable", { seq })}
        </p>
      </Panel>
    );
  }
  const included = manifest.items.filter((item) => item.outcome === "included");
  const cut = manifest.items.filter((item) => item.outcome === "cut");
  return (
    <Panel
      title={t("title")}
      aside={
        <span className="flex flex-wrap items-center gap-2">
          <span
            data-testid="run-manifest-tally"
            className={`${mono} text-xs text-muted-foreground`}
          >
            {t("tally", {
              rendered: count(manifest.included),
              cut: count(manifest.cut),
              tokens: count(manifest.spent_tokens),
            })}
          </span>
          <button
            type="button"
            disabled
            title={t("previewGap")}
            aria-describedby="run-manifest-preview-why"
            data-testid="run-manifest-preview"
            data-gap="steering-preview"
            className={`${buttonSecondary} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {t("preview")}
          </button>
          <span id="run-manifest-preview-why" className="sr-only">
            {t("previewGap")}
          </span>
        </span>
      }
    >
      {run.enforcementTier === "observe" ? (
        <p className="pb-3 text-sm text-muted-foreground">
          {t("notDelivered")}
        </p>
      ) : null}
      <ol className="flex flex-col gap-1.5" data-testid="run-manifest">
        {included.map((item, index) => (
          <li
            key={`${item.ref ?? item.kind}-${String(index)}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className={`${mono} text-xs text-dim`}>
                {t("rank", { rank: index + 1 })}
              </span>
              <span className={`${mono} truncate`}>
                {item.ref ?? item.kind}
              </span>
              <Badge tone="quiet" dot={false}>
                {item.force}
              </Badge>
            </span>
            <span className={`${mono} text-xs text-muted-foreground`}>
              {t("tokens", { tokens: count(item.tokens) })}
            </span>
          </li>
        ))}
        {cut.map((item, index) => (
          <li
            key={`cut-${item.ref ?? item.kind}-${String(index)}`}
            data-testid="run-manifest-cut"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className={`${mono} truncate`}>
                {item.ref ?? item.kind}
              </span>
              <Badge tone="quiet" dot={false}>
                {t(`reason.${item.reason ?? "unrecorded"}`)}
              </Badge>
            </span>
            <span className="text-xs">
              {item.reason === "superseded" && item.superseded_by !== undefined
                ? t("supersededBy", { by: item.superseded_by })
                : t(`why.${item.reason ?? "unrecorded"}`)}
            </span>
          </li>
        ))}
      </ol>
      <p className={`${mono} pt-3 text-[11px] text-muted-foreground`}>
        {t("footer", {
          version: manifest.bundle_version,
          seq,
          budget: count(manifest.budget_tokens),
        })}
      </p>
    </Panel>
  );
}

export function ContextSection({
  run,
  read,
  manifest,
  place,
}: {
  run: RunRow;
  read: Read<RunTranscript>;
  /** The manifest frame's body, read when the run sealed one. */
  manifest: { seq: string; read: Read<RunFrameBody> } | null;
  place: Place;
}) {
  const t = useTranslations("run.context");
  const locale = useLocale();
  const entries = entriesOf(read, "recall");
  return (
    <div className="flex flex-col gap-4">
      <Unrecorded title={t("prompt.title")} gap="G10">
        {t("prompt.none")}
      </Unrecorded>
      <Manifest
        run={run}
        seq={manifest?.seq ?? null}
        body={manifest?.read ?? null}
      />
      <Unrecorded title={t("window.title")} gap="G10">
        {t("window.none")}
      </Unrecorded>
      <Panel title={t("frames.title")}>
        {!read.ok ? (
          <ReadFailure read={read} section={t("frames.title")} />
        ) : entries === null || entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <Table
            label={t("frames.title")}
            columns={[
              { label: t("frames.kind") },
              { label: t("frames.frame") },
              { label: t("frames.tokens"), numeric: true },
              { label: t("frames.score"), numeric: true },
              { label: t("frames.cited") },
            ]}
          >
            {entries.map((entry) => (
              <tr key={entryKey(entry)}>
                <td className={`${cell} ${mono}`}>{entry.label}</td>
                <td className={cell}>
                  <FrameLink
                    seq={entry.seq}
                    chainRef={entry.subagent?.chainRef}
                    place={place}
                  />
                  <span className="ml-2 text-xs text-muted-foreground">
                    {formatDuration(entry.elapsedMs, locale)}
                  </span>
                </td>
                <td className={numericCell}>
                  <NoValue />
                </td>
                <td className={numericCell}>
                  <NoValue />
                </td>
                <td className={cell}>
                  <NoValue />
                </td>
              </tr>
            ))}
          </Table>
        )}
        {read.ok && !isWhole(read.value) ? (
          <p className="pt-3 text-xs text-muted-foreground">{t("cut")}</p>
        ) : null}
      </Panel>
      <Unrecorded title={t("walk.title")} gap="G10">
        {t("walk.none")}
      </Unrecorded>
      <Unrecorded title={t("stats.title")} gap="G10">
        {t("stats.none")}
      </Unrecorded>
    </div>
  );
}
