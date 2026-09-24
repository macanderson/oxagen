// Audit's five tabs past Events (rev1 audit.md, Tabs): Incidents, Receipts,
// Exports, Keys and Retention. Each keeps the design's panels, headings and
// actions, and where no store backs a panel's rows its body is one sentence
// saying what is missing (`data-testid="audit-not-recorded"`, with the issue
// that adds it as `data-issue`). Nothing here prints a fixture, a zero or a
// count the record does not hold: a tile the record cannot fill says
// "not recorded", and a table with no source is not drawn.
//
// What each tab waits on is in gaps.ts. Three panels have a real source.
// Exports shows the organization export Build bundle queued (export_data, read
// back with get_export_status by the id its URL carries). Retention prints the
// body retention of the pinned policy (get_evidence_retention). Redaction: the
// collector redacts before a frame body is written
// (packages/tacho/src/evidence/redaction.ts, frame-body.ts), and the note says
// only what that code does.
import "server-only";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { AuditBundle, AuditRetention } from "@/data/contracts/audit";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { DownloadLink } from "@/ui/navigation";
import { BundleRefresh } from "./bundle-refresh";
import { IncidentDialog, PolicyDialog, RotateDialog } from "./dialogs";
import { AUDIT_GAPS } from "./gaps";
import { useRetentionWindow } from "./retention";

type GapKey = keyof typeof AUDIT_GAPS;

/** The one sentence a panel with no store behind it renders in place of its rows. */
function NotBacked({ gap, children }: { gap: GapKey; children: string }) {
  return (
    <p
      data-testid="audit-not-recorded"
      data-issue={AUDIT_GAPS[gap].issue}
      className="max-w-prose text-[13px] text-muted-foreground"
    >
      {children}
    </p>
  );
}

function Panel({
  id,
  title,
  caption,
  aside,
  children,
}: {
  id: string;
  title: string;
  caption?: string;
  /** The store badge and the panel's action, right of the heading. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={`${panel} flex flex-col`}>
      <header className={panelHeader}>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={id} className={panelTitle}>
            {title}
          </h2>
          {caption ? (
            <span className="text-[12.5px] text-muted-foreground">
              {caption}
            </span>
          ) : null}
        </span>
        {aside ? (
          <span className="flex flex-wrap items-center gap-2">{aside}</span>
        ) : null}
      </header>
      <div className={panelBody}>{children}</div>
    </section>
  );
}

function UnrecordedTile({ term }: { term: string }) {
  const t = useTranslations("audit");
  return (
    <div className={statTile}>
      <dt className={statTerm}>{term}</dt>
      <dd className={`${statValue} text-muted-foreground`}>
        <span data-recorded="false" className="text-[15px] font-medium">
          {t("notRecorded")}
        </span>
      </dd>
    </div>
  );
}

export function IncidentsTab() {
  const t = useTranslations("audit.incidents");
  const tiles = useTranslations("audit.tiles");
  return (
    <div className="flex flex-col gap-3.5">
      <dl aria-label={tiles("label")} className={statStrip}>
        <UnrecordedTile term={t("open")} />
        <UnrecordedTile term={t("critical")} />
        <UnrecordedTile term={t("median")} />
        <UnrecordedTile term={t("money")} />
      </dl>
      <Panel
        id="audit-incidents"
        title={t("title")}
        caption={t("caption")}
        aside={<IncidentDialog gap={AUDIT_GAPS.incidents} />}
      >
        <NotBacked gap="incidents">{t("notRecorded")}</NotBacked>
      </Panel>
    </div>
  );
}

/** The design's example searches (audit.md, Receipts), drawn and disabled with the search. */
const RECEIPT_CHIPS = [
  "stripe",
  "harness",
  "observe",
  "deny",
  "agentKey",
  "effect",
] as const;

export function ReceiptsTab() {
  const t = useTranslations("audit.receipts");
  const note = "audit-receipts-note";
  return (
    <section
      aria-labelledby="audit-receipts"
      className={`${panel} flex flex-col`}
    >
      <header className={panelHeader}>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="audit-receipts" className={panelTitle}>
            {t("title")}
          </h2>
          <span className="text-[12.5px] text-muted-foreground">
            {t("caption")}
          </span>
        </span>
      </header>
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <span className="flex flex-wrap items-center gap-2">
          <label className="min-w-48 flex-1">
            <span className="sr-only">{t("search")}</span>
            <input
              type="search"
              disabled
              placeholder={t("searchPlaceholder")}
              aria-describedby={note}
              className={`${inputBase} max-md:text-base`}
            />
          </label>
          <button
            type="button"
            disabled
            aria-describedby={note}
            className={buttonSecondary}
          >
            {t("submit")}
          </button>
        </span>
        <ul
          aria-label={t("examples")}
          className="flex flex-wrap items-center gap-1.5"
        >
          {RECEIPT_CHIPS.map((chip) => (
            <li key={chip}>
              <button
                type="button"
                disabled
                aria-describedby={note}
                className={`${buttonSecondary} min-h-7 px-2 py-0.5 text-xs`}
              >
                {t(`chips.${chip}`)}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              disabled
              aria-describedby={note}
              className="min-h-7 px-2 text-xs text-muted-foreground"
            >
              {t("clear")}
            </button>
          </li>
        </ul>
      </div>
      <div className={panelBody}>
        <p
          id={note}
          data-testid="audit-not-recorded"
          data-issue={AUDIT_GAPS.receipts.issue}
          className="max-w-prose text-[13px] text-muted-foreground"
        >
          {t("notRecorded")}
        </p>
      </div>
    </section>
  );
}

const BUNDLE_TONE: Record<AuditBundle["status"], BadgeTone> = {
  queued: "approval",
  processing: "approval",
  ready: "allowed",
  failed: "failed",
};

/** One fact on an export card, "not recorded" when the record holds none. */
function Fact({ term, children }: { term: string; children?: ReactNode }) {
  const t = useTranslations("audit");
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words">
        {children ?? (
          <span data-recorded="false" className="text-muted-foreground">
            {t("notRecorded")}
          </span>
        )}
      </dd>
    </>
  );
}

/**
 * The organization export Build bundle queued, read back by its id: its
 * status as a dot and a word, Download once the archive exists, and the
 * design's facts, each "not recorded" where a ZIP data export carries none.
 */
function BundleCard({
  org,
  id,
  read,
}: {
  org: string;
  id: string;
  read: Read<AuditBundle>;
}) {
  const t = useTranslations("audit.exports");
  const format = useFormatter();
  if (!read.ok) {
    const code = read.reason === "error" ? read.code : read.reason;
    return (
      <p
        data-testid="audit-bundle-unread"
        className={`${panel} px-4 py-3 text-[13px] text-muted-foreground`}
      >
        {t("unread", { id, code })}
      </p>
    );
  }
  const bundle = read.value;
  const building = bundle.status === "queued" || bundle.status === "processing";
  const verifyNote = `audit-bundle-verify-${bundle.exportId}`;
  return (
    <article
      aria-labelledby={`audit-bundle-${bundle.exportId}`}
      data-testid="audit-bundle"
      className={`${panel} flex flex-col`}
    >
      <header className={panelHeader}>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id={`audit-bundle-${bundle.exportId}`} className={panelTitle}>
            {t("card")}
          </h2>
          <Badge
            tone={BUNDLE_TONE[bundle.status]}
            dot={building ? "pulse" : true}
            data-status={bundle.status}
          >
            {t(`states.${bundle.status}`)}
          </Badge>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled
            aria-describedby={verifyNote}
            className={buttonSecondary}
          >
            {t("verify")}
          </button>
          {bundle.ready ? (
            <DownloadLink
              to={routes.accountExport(org, bundle.exportId)}
              data-export="bundle"
              className={buttonPrimary}
            >
              {t("download")}
            </DownloadLink>
          ) : null}
        </span>
      </header>
      <div className={`${panelBody} flex flex-col gap-3`}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <Fact term={t("exportId")}>
            <span className={mono}>{bundle.exportId}</span>
          </Fact>
          <Fact term={t("range")} />
          <Fact term={t("contents")}>{t("contentsOrg")}</Fact>
          <Fact term={t("size")} />
          <Fact term={t("created")} />
          {bundle.completedAt === null ? null : (
            <Fact term={t("completed")}>
              {format.dateTime(new Date(bundle.completedAt), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </Fact>
          )}
          <Fact term={t("signature")} />
          <Fact term={t("keyIds")} />
        </dl>
        <p
          id={verifyNote}
          data-testid="audit-not-recorded"
          data-issue={AUDIT_GAPS.exports.issue}
          className="text-xs text-muted-foreground"
        >
          {t("verifyNotRecorded")}
        </p>
      </div>
      {building ? <BundleRefresh /> : null}
    </article>
  );
}

export function ExportsTab({
  org,
  bundle,
}: {
  org: string;
  /** The export the URL names (`?export=<id>`) and its read, or null when it names none. */
  bundle: { id: string; read: Read<AuditBundle> } | null;
}) {
  const t = useTranslations("audit.exports");
  return (
    <div className="flex flex-col gap-3.5">
      <p className="border-l-2 border-gold pl-3 text-[13px] text-muted-foreground">
        {t("callout")}
      </p>
      {bundle === null ? null : (
        <BundleCard org={org} id={bundle.id} read={bundle.read} />
      )}
      <NotBacked gap="exports">{t("notRecorded")}</NotBacked>
      <div className="grid gap-3.5 md:grid-cols-2">
        <Panel id="audit-verifier" title={t("verifier")}>
          <NotBacked gap="exports">{t("verifierNotRecorded")}</NotBacked>
        </Panel>
        <Panel id="audit-outbound" title={t("outbound")}>
          <NotBacked gap="exports">{t("outboundNotRecorded")}</NotBacked>
        </Panel>
      </div>
    </div>
  );
}

export function KeysTab() {
  const t = useTranslations("audit.keys");
  return (
    <Panel
      id="audit-keys"
      title={t("title")}
      aside={
        <>
          <Badge tone="quiet" dot={false} mono>
            {t("store")}
          </Badge>
          <RotateDialog gap={AUDIT_GAPS.keys} />
        </>
      }
    >
      <NotBacked gap="keys">{t("notRecorded")}</NotBacked>
    </Panel>
  );
}

/** One of the policy's fields: the recorded value, or "not recorded". */
function PolicyField({
  term,
  children,
}: {
  term: string;
  children: ReactNode | null;
}) {
  const t = useTranslations("audit");
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-1.5 md:grid-cols-[14rem_1fr]">
      <dt className="text-[13px] font-medium">{term}</dt>
      <dd className="text-[13px] text-muted-foreground">
        {children ?? <span data-recorded="false">{t("notRecorded")}</span>}
      </dd>
    </div>
  );
}

export function RetentionTab({
  retention,
}: {
  retention: Read<AuditRetention>;
}) {
  const t = useTranslations("audit.retention");
  const format = useFormatter();
  const windowOf = useRetentionWindow();
  const policy = retention.ok ? retention.value : null;
  const body = policy === null ? null : windowOf(policy.bodyRetentionDays);
  const rate = policy?.rate ?? null;
  const stored = policy?.storedGbBeyondIncluded ?? null;
  // The volume and the rate, never a product of the two: money is not
  // multiplied through a float (data/contracts/money.ts), and the rate is the
  // basis the figure would be priced on.
  const cold =
    policy === null || stored === null || rate === null ? null : (
      <>
        {t("coldValue", {
          gb: format.number(stored, { maximumFractionDigits: 2 }),
          months: format.number(policy.includedMonths),
        })}{" "}
        · <Money value={rate} precision="exact" /> {t("coldRate")}
      </>
    );
  return (
    <div className="flex flex-col gap-3.5">
      <Panel
        id="audit-retention"
        title={t("title")}
        aside={
          <>
            <Badge tone="quiet" dot={false} mono>
              {t("store")}
            </Badge>
            <PolicyDialog
              gap={AUDIT_GAPS.retention}
              body={body === null ? null : t("bodyValue", { window: body })}
            />
          </>
        }
      >
        <dl className="flex flex-col divide-y divide-border">
          <PolicyField term={t("body")}>
            {body === null ? null : t("bodyValue", { window: body })}
          </PolicyField>
          <PolicyField term={t("hot")}>{null}</PolicyField>
          <PolicyField term={t("replay")}>{null}</PolicyField>
          <PolicyField term={t("optDown")}>{null}</PolicyField>
          <PolicyField term={t("cold")}>{cold}</PolicyField>
        </dl>
        <div className="pt-2">
          <NotBacked gap="retention">{t("notRecorded")}</NotBacked>
        </div>
      </Panel>
      <Panel id="audit-tiers" title={t("tiers")}>
        <NotBacked gap="retention">{t("tiersNotRecorded")}</NotBacked>
      </Panel>
      <Panel
        id="audit-redaction"
        title={t("redaction")}
        caption={t("redactionCaption")}
      >
        <p className="border-l-2 border-gold pl-3 text-[13px] text-muted-foreground">
          {t("redactionNote")}
        </p>
      </Panel>
    </div>
  );
}
