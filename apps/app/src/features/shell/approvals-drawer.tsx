"use client";
// The approvals drawer (mockup `apdHtml()`, fleet.md "Approvals drawer",
// audit-prompt check 7): everything parked for a person across the
// organization, behind the topbar button on every page. The list first, under
// "N waiting on you", then what was resolved today; picking a row shows the
// full approval card with "‹ All approvals" above it. Escape and the scrim
// close it, and the countdowns keep ticking inside it.
//
// The card is the Fleet lane's, rendered on the server (shell-chrome.tsx) and
// handed in by approval id, so Approve and Deny here are the same governed
// write (`resolve_approval`, its IAM check in the handler) as on Fleet and Run.
//
// A resolved row opens too: the same chain, with the resolution, when it was
// made and by whom, and no decision to take.
//
// A countdown under two minutes takes the warning tone, as the mockup's
// `.apsm-clk.warn` does. A parked call's risk and fired rules are in
// `agent.approval_requests`, but `list_approvals` does not return the risk,
// and no amount, side effect, taint or task is recorded, so a row draws none
// of them, the critical border (risk critical, irreversible or tainted) has
// nothing to read, and one line says so (#3848). An interjection has no
// record (#3849), so the list holds approvals only and a line says that too.
import { ChevronLeft, ShieldCheck, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useFormatter } from "@/ui/formatter";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  ApprovalItem,
  ResolvedApprovalItem,
} from "@/data/contracts/approvals";
import { Badge } from "@/ui/badge";
import { buttonSecondary, linkText, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { routes } from "@/shared/safe-path";
import { ReadFailure } from "@/ui/read-failure";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { orgWaiting } from "./use-activity";

/** The issues that own what a row cannot show, carried as data attributes only. */
const ROW_GAP = "#3848";
const INTERJECTION_GAP = "#3849";

/** Under two minutes left, a countdown takes the critical ink (mockup `sec<120`, `.apsm-clk.warn`). */
export const WARN_BELOW_SECONDS = 120;

/** `m:ss` until `at`, or null once it has passed. */
export function countdown(at: number, now: number): string | null {
  const left = Math.floor((at - now) / 1000);
  if (left <= 0) return null;
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${String(m)}:${String(s).padStart(2, "0")}`;
}

/**
 * The drawer's clock: the instant the chrome's reads were made, then the
 * browser's, once a second while the drawer is open. A closed drawer sets no
 * timer.
 */
function useTicking(readAt: number, running: boolean): number {
  const [now, setNow] = useState(readAt);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [running]);
  return running ? now : readAt;
}

/** The agent's last segment, as the mockup's row names it (`release-manager`). */
function shortAgent(key: string | null): string | null {
  if (key === null) return null;
  return key.split(".").at(-1) ?? key;
}

function Glyph() {
  return (
    <span
      aria-hidden="true"
      className="grid size-7 flex-none place-items-center rounded-lg border border-border bg-card text-muted-foreground"
    >
      <ShieldCheck className="size-3.5" />
    </span>
  );
}

function PendingRow({
  item,
  wsName,
  now,
  onOpen,
}: {
  item: ApprovalItem;
  wsName: string;
  now: number;
  onOpen: () => void;
}) {
  const t = useTranslations("shell.approvals");
  const at = Date.parse(item.expiresAt);
  const left = countdown(at, now);
  const warn = left !== null && at - now < WARN_BELOW_SECONDS * 1000;
  const agent = shortAgent(item.agentKey);
  return (
    <li>
      <button
        type="button"
        data-testid="approval-row"
        aria-label={t("openApproval", { id: item.id })}
        onClick={onOpen}
        className="flex w-full items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-card-foreground transition-colors hover:border-rule focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Glyph />
        <span className="min-w-0 flex-1">
          <b className="block break-all font-mono text-[13px] font-semibold">
            {item.tool}
          </b>
          <span className="block text-xs text-muted-foreground">
            {[agent, wsName].filter((part) => part !== null).join(" · ")}
          </span>
        </span>
        <span
          data-countdown={item.id}
          data-warn={warn ? "" : undefined}
          className={`flex-none font-mono text-[13px] font-semibold ${
            warn ? "text-critical" : "text-info"
          }`}
        >
          {left ?? t("expired")}
        </span>
      </button>
    </li>
  );
}

function ResolvedRow({
  item,
  wsName,
  onOpen,
}: {
  item: ResolvedApprovalItem;
  wsName: string;
  onOpen: () => void;
}) {
  const t = useTranslations("shell.approvals");
  const agent = shortAgent(item.agentKey ?? null);
  return (
    <li>
      <button
        type="button"
        data-testid="resolved-row"
        aria-label={t("openApproval", { id: item.id })}
        onClick={onOpen}
        className="flex w-full items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-card-foreground opacity-80 transition-colors hover:border-rule focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Glyph />
        <span className="min-w-0 flex-1">
          <b className="block break-all font-mono text-[13px] font-semibold">
            {item.tool}
          </b>
          <span className="block text-xs text-muted-foreground">
            {[agent, wsName].filter((part) => part !== null).join(" · ")}
          </span>
        </span>
        <span className="flex-none">
          <Badge tone={item.resolution === "approved" ? "allowed" : "denied"}>
            {t(`resolution.${item.resolution}`)}
          </Badge>
        </span>
      </button>
    </li>
  );
}

/**
 * A resolved call, opened from its row: the chain the card draws, then the
 * resolution, when it was made and by whom. There is nothing left to decide,
 * so there is no decision footer.
 */
function ResolvedCard({
  item,
  org,
  ws,
}: {
  item: ResolvedApprovalItem;
  org: string;
  ws: string;
}) {
  const t = useTranslations("shell.approvals.resolvedCard");
  const tr = useTranslations("shell.approvals");
  const format = useFormatter();
  const recorded = (value: string | null | undefined) =>
    value === null || value === undefined ? (
      <dd className="text-muted-foreground">{t("notRecorded")}</dd>
    ) : (
      <dd className={`${mono} break-all`}>{value}</dd>
    );
  return (
    <div
      data-testid="resolved-card"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
    >
      <p className={`${mono} break-all font-semibold`}>{item.tool}</p>
      <dl
        aria-label={t("chain")}
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"
      >
        <dt className="text-muted-foreground">{t("who")}</dt>
        {recorded(item.requester)}
        <dt className="text-muted-foreground">{t("agent")}</dt>
        {recorded(item.agentKey)}
        <dt className="text-muted-foreground">{t("action")}</dt>
        <dd className={`${mono} break-all`}>{item.tool}</dd>
        <dt className="text-muted-foreground">{t("rule")}</dt>
        {recorded(item.rule)}
        <dt className="text-muted-foreground">{t("resolution")}</dt>
        <dd>
          <Badge tone={item.resolution === "approved" ? "allowed" : "denied"}>
            {tr(`resolution.${item.resolution}`)}
          </Badge>
        </dd>
        <dt className="text-muted-foreground">{t("resolvedAt")}</dt>
        <dd>
          <time dateTime={item.resolvedAt} className={mono}>
            {format.dateTime(new Date(item.resolvedAt), {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hourCycle: "h23",
            })}
          </time>
        </dd>
        <dt className="text-muted-foreground">{t("resolvedBy")}</dt>
        {recorded(item.resolvedBy)}
      </dl>
      {item.runId === null ? null : (
        <SafeLink
          to={routes.run(org, ws, item.runId)}
          className={`${linkText} self-start text-xs`}
        >
          {t("openRun")}
        </SafeLink>
      )}
    </div>
  );
}

const eyebrow =
  "mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground";

export function ApprovalsDrawer({
  data,
  cards,
}: {
  data: ShellData;
  /** The full approval card for each parked call, rendered on the server. */
  cards: Readonly<Record<string, ReactNode>>;
}) {
  const t = useTranslations("shell.approvals");
  const { approvalsOpen, setApprovalsOpen } = useShellState();
  const [selected, setSelected] = useState<
    | { kind: "pending"; id: string }
    | { kind: "resolved"; item: ResolvedApprovalItem; slug: string }
    | null
  >(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const now = useTicking(data.approvals.readAt, approvalsOpen);
  const waiting = orgWaiting(data);
  const n = waiting?.count ?? null;

  const close = () => {
    setApprovalsOpen(false);
    setSelected(null);
    document.getElementById("apdrawer-button")?.focus();
  };

  // Escape closes the drawer, unless a dialog over it (Approve, Deny) has the
  // key: that dialog closes first, as the mockup's `!S.dlg` guard has it.
  useEffect(() => {
    if (!approvalsOpen) return;
    closeRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
        return;
      setApprovalsOpen(false);
      setSelected(null);
      document.getElementById("apdrawer-button")?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [approvalsOpen, setApprovalsOpen]);

  const pending = data.approvals.workspaces.flatMap((w) =>
    w.pending.ok
      ? w.pending.value.items.map((item) => ({ item, wsName: w.name }))
      : [],
  );
  const resolved = data.approvals.workspaces.flatMap((w) =>
    w.resolved.ok
      ? w.resolved.value.items.map((item) => ({
          item,
          wsName: w.name,
          slug: w.slug,
        }))
      : [],
  );
  const open = (next: NonNullable<typeof selected>) => {
    setSelected(next);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };
  const resolvedMore = data.approvals.workspaces.some(
    (w) => w.resolved.ok && w.resolved.value.more,
  );
  const failures = data.approvals.workspaces.flatMap((w) => [
    ...(w.pending.ok ? [] : [{ key: `${w.slug}-p`, read: w.pending, w }]),
    ...(w.resolved.ok ? [] : [{ key: `${w.slug}-r`, read: w.resolved, w }]),
  ]);
  const waitingLabel =
    n === null ? null : `${String(n)}${waiting?.partial === true ? "+" : ""}`;

  return (
    <>
      <div
        data-testid="apdrawer-scrim"
        aria-hidden="true"
        onClick={close}
        className={`fixed inset-0 z-50 bg-overlay-scrim transition-opacity motion-reduce:transition-none ${
          approvalsOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        id="apdrawer"
        role="complementary"
        aria-label={t("title")}
        aria-hidden={approvalsOpen ? undefined : true}
        inert={!approvalsOpen}
        data-open={approvalsOpen ? "" : undefined}
        className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-app-panel-bg text-app-panel-fg shadow-2xl transition-transform motion-reduce:transition-none md:w-[min(680px,90vw)] ${
          approvalsOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <h3 className="text-[15px] font-semibold">{t("title")}</h3>
          {waitingLabel === null ? null : (
            <Badge tone={n !== null && n > 0 ? "approval" : "quiet"}>
              {t("waiting", { count: waitingLabel })}
            </Badge>
          )}
          <button
            ref={closeRef}
            type="button"
            data-touch-target=""
            aria-label={t("close")}
            onClick={close}
            className="ml-auto grid size-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        <div
          ref={bodyRef}
          data-testid="apdrawer-body"
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          {selected !== null ? (
            <>
              <button
                type="button"
                className={`${buttonSecondary} mb-3`}
                onClick={() => {
                  setSelected(null);
                  if (bodyRef.current) bodyRef.current.scrollTop = 0;
                }}
              >
                <ChevronLeft aria-hidden="true" className="size-3.5" />
                {t("all")}
              </button>
              {selected.kind === "resolved" ? (
                <ResolvedCard
                  item={selected.item}
                  org={data.org.slug}
                  ws={selected.slug}
                />
              ) : (
                (cards[selected.id] ?? (
                  <p className="text-sm text-muted-foreground">{t("gone")}</p>
                ))
              )}
            </>
          ) : (
            <>
              {failures.map(({ key, read, w }) =>
                read.ok ? null : (
                  <div key={key} className="mb-3">
                    <ReadFailure read={read} section={w.name} />
                  </div>
                ),
              )}
              {pending.length > 0 ? (
                <>
                  <p className={eyebrow}>
                    {/* The header's "+" carries into the list it heads. */}
                    {t("waitingOnYou", {
                      count: `${String(pending.length)}${waiting?.partial === true ? "+" : ""}`,
                    })}
                  </p>
                  <ul className="flex flex-col gap-2">
                    {pending.map(({ item, wsName }) => (
                      <PendingRow
                        key={item.id}
                        item={item}
                        wsName={wsName}
                        now={now}
                        onOpen={() => {
                          open({ kind: "pending", id: item.id });
                        }}
                      />
                    ))}
                  </ul>
                  <p
                    data-testid="approval-row-not-backed"
                    data-gap={ROW_GAP}
                    className="mt-2 text-xs text-muted-foreground"
                  >
                    {t("rowNotBacked")}
                  </p>
                </>
              ) : (
                <div className="px-1.5 py-6 text-center">
                  <p className="text-[12.5px] text-muted-foreground">
                    {t("empty")}
                  </p>
                  <p className="mt-2 text-[11.5px] text-muted-foreground">
                    {t.rich("emptyDetail", {
                      code: (chunks) => (
                        <span className="font-mono">{chunks}</span>
                      ),
                    })}
                  </p>
                </div>
              )}
              <p
                data-testid="interjection-not-backed"
                data-gap={INTERJECTION_GAP}
                className="mt-2 text-xs text-muted-foreground"
              >
                {t("interjectionNotBacked")}
              </p>
              {data.approvals.truncated ? (
                <p
                  data-testid="apdrawer-truncated"
                  className="mt-2 text-xs text-muted-foreground"
                >
                  {t("truncated", { count: data.approvals.workspaces.length })}
                </p>
              ) : null}
              {resolved.length > 0 ? (
                <>
                  <p className={`${eyebrow} mt-5`}>
                    {t("resolvedToday", {
                      count: `${String(resolved.length)}${resolvedMore ? "+" : ""}`,
                    })}
                  </p>
                  <ul className="flex flex-col gap-2">
                    {resolved.map(({ item, wsName, slug }) => (
                      <ResolvedRow
                        key={item.id}
                        item={item}
                        wsName={wsName}
                        onOpen={() => {
                          open({ kind: "resolved", item, slug });
                        }}
                      />
                    ))}
                  </ul>
                </>
              ) : null}
              <p className="mt-4 rounded-lg border border-border bg-hl px-3 py-2.5 text-[11.5px] text-muted-foreground">
                {t("note")}
              </p>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
