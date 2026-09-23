// Audit's five tabs past Events (rev1 audit.md, Tabs): Incidents, Receipts,
// Exports, Keys and Retention. Each keeps the design's panels, headings and
// actions, and where no store backs a panel's rows its body is one sentence
// saying what is missing (`data-testid="audit-not-recorded"`, with the issue
// that adds it as `data-issue`). Nothing here prints a fixture, a zero or a
// count the record does not hold: a tile the record cannot fill says
// "not recorded", and a table with no source is not drawn.
//
// What each tab waits on is in gaps.ts. The one panel with a real source is
// Redaction: the collector redacts before a frame body is written
// (packages/tacho/src/evidence/redaction.ts, frame-body.ts), and the note says
// only what that code does.
import "server-only";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Badge } from "@/ui/badge";
import {
  panel,
  panelBody,
  panelHeader,
  panelTitle,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { IncidentDialog, PolicyDialog, RotateDialog } from "./dialogs";
import { AUDIT_GAPS } from "./gaps";

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

export function ReceiptsTab() {
  const t = useTranslations("audit.receipts");
  return (
    <Panel id="audit-receipts" title={t("title")} caption={t("caption")}>
      <NotBacked gap="receipts">{t("notRecorded")}</NotBacked>
    </Panel>
  );
}

export function ExportsTab() {
  const t = useTranslations("audit.exports");
  return (
    <div className="flex flex-col gap-3.5">
      <Panel id="audit-exports" title={t("title")} caption={t("caption")}>
        <NotBacked gap="exports">{t("notRecorded")}</NotBacked>
      </Panel>
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

export function RetentionTab() {
  const t = useTranslations("audit.retention");
  return (
    <div className="flex flex-col gap-3.5">
      <Panel
        id="audit-retention"
        title={t("title")}
        aside={<PolicyDialog gap={AUDIT_GAPS.retention} />}
      >
        <NotBacked gap="retention">{t("notRecorded")}</NotBacked>
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
