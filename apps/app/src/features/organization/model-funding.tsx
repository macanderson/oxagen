// Organization › Model funding and routes (pages/organization.md, mockup
// `orgKeyPanel` and `orgRoutesPanel`): which key pays for Oxagen's own model
// calls, then the route each of Oxagen's tiers takes. It renders inside the
// Organization frame, so the header, the tabs and the four not-loaded states
// are the frame's.
//
// Funding source. `get_model_credential` reports a customer key (ADR-053), and
// a stored, active one makes the source customer_key, with the key field that
// tests, saves and removes it. Without one Oxagen pays, on the organization's
// minted OpenRouter key or the shared key (ADR-131), and no capability reads
// which (#4005), so no source is chosen until the person picks one to look
// at. platform_minted draws the design's two states apart, a key held (its
// facts, Rotate, Revoke and the Reconciliation block) and no key (the note
// and Mint a key), because nothing reads which of the two is true: every fact
// says "not recorded", and Mint a key, Rotate, Revoke and the source switch
// are stubs that say what they would do.
//
// Model routes. §4.5's tiers are fixed (complex, light, embed, rerank), and
// nothing stores a route, a fallback, or a tier's use and cost per
// organization (#4006). The table draws the four tiers with those cells "not
// recorded", Edit as a stub, and the Total with the basis the figure will
// carry, client_attested, and no figure.
//
// Owner or Admin only: the frame refuses anyone below before the read, and
// all four credential handlers check the role again (INV-29).
import { useTranslations } from "next-intl";
import type { ModelCredential } from "@/data/contracts/org";
import type { Read } from "@/data/read";
import { Badge } from "@/ui/badge";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { FundingPicker } from "./funding-picker";
import {
  FUNDING_SOURCES,
  type FundingSource,
  recordedSource,
} from "./funding-sources";
import { ModelFundingForm } from "./model-funding-form";
import { NotRecordedValue, note } from "./parts";
import { DetailsDialog, StubDialog } from "./stub-dialog";

/** §4.5's tiers for Oxagen's own work, in the order the design lists them. */
const TIERS = ["complex", "light", "embed", "rerank"] as const;

const term = "text-muted-foreground";
const facts = "grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm";

export function ModelFundingTab({
  org,
  orgName,
  read,
}: {
  org: string;
  orgName: string;
  read: Read<ModelCredential>;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      <FundingSourcePanel org={org} orgName={orgName} read={read} />
      <ModelRoutes />
    </div>
  );
}

function FundingSourcePanel({
  org,
  orgName,
  read,
}: {
  org: string;
  orgName: string;
  read: Read<ModelCredential>;
}) {
  const t = useTranslations("organization.modelFunding.funding");
  const current = read.ok ? recordedSource(read.value) : null;
  return (
    <section aria-labelledby="org-funding" className={panel}>
      <div className={panelHeader}>
        <h2 id="org-funding" className={panelTitle}>
          {t("title")}
        </h2>
        {current === null ? (
          <Badge tone="quiet" dot={false} data-source="not-recorded">
            {t("sourceUnrecorded")}
          </Badge>
        ) : (
          <Badge tone="allowed" data-source={current}>
            {current}
          </Badge>
        )}
      </div>
      <div className={`${panelBody} flex flex-col gap-3.5`}>
        {read.ok ? (
          <FundingPicker
            current={current}
            states={{
              customer_key: <CustomerKey org={org} credential={read.value} />,
              platform_minted: <MintedKey orgName={orgName} />,
              platform: <SharedKey />,
            }}
          />
        ) : (
          <ReadFailure read={read} section={t("title")} />
        )}
        <div>
          <ChangeSource current={current} />
        </div>
        <p className={note}>{t("note")}</p>
      </div>
    </section>
  );
}

/** customer_key: the saved key's facts, then the form that tests, saves and removes it. */
function CustomerKey({
  org,
  credential,
}: {
  org: string;
  credential: ModelCredential;
}) {
  const t = useTranslations("organization.modelFunding.funding");
  return (
    <div className="flex flex-col gap-3.5">
      <dl className={facts}>
        <dt className={term}>{t("facts.key")}</dt>
        <dd>
          {credential.configured && credential.keyHint !== null ? (
            <span className={mono}>
              {t("customer.keyHint", { hint: credential.keyHint })}
            </span>
          ) : (
            <span className="text-dim">{t("customer.keyNone")}</span>
          )}
        </dd>
        <dt className={term}>{t("facts.billing")}</dt>
        <dd>{t("customer.billing")}</dd>
        <dt className={term}>{t("facts.storage")}</dt>
        <dd>{t("customer.storage")}</dd>
        <dt className={term}>{t("facts.engine")}</dt>
        <dd>
          <NotRecordedValue />
        </dd>
      </dl>
      <ModelFundingForm org={org} credential={credential} />
    </div>
  );
}

/**
 * platform_minted: the design's two states of the minted key, each under its
 * own heading, because no capability reads whether a key is held (#4005).
 */
function MintedKey({ orgName }: { orgName: string }) {
  const t = useTranslations("organization.modelFunding.funding");
  const heading =
    "text-[10.5px] font-semibold uppercase tracking-[0.09em] text-dim";
  return (
    <div className="flex flex-col gap-4" data-issue="4005">
      <p className="text-[12px] text-dim">{t("minted.unrecorded")}</p>
      <section aria-labelledby="funding-minted-held" data-key-state="held">
        <h3 id="funding-minted-held" className={`${heading} mb-2`}>
          {t("minted.heldTitle")}
        </h3>
        <HeldKey orgName={orgName} />
      </section>
      <section
        aria-labelledby="funding-minted-none"
        data-key-state="none"
        className="border-t border-border pt-3"
      >
        <h3 id="funding-minted-none" className={`${heading} mb-2`}>
          {t("minted.noKeyTitle")}
        </h3>
        <p className={note}>{t("minted.noKey", { org: orgName })}</p>
        <div className="mt-3">
          <StubDialog
            open={t("minted.mint.open")}
            title={t("minted.mint.title", { org: orgName })}
            body={t("minted.mint.body")}
            testId="funding-mint-key"
          />
        </div>
      </section>
    </div>
  );
}

/**
 * The held key's facts, Rotate and Revoke, then Reconciliation: what the
 * provider reports on this key beside what Oxagen's ledger debited. None of it
 * is read yet (#4005), so every row says "not recorded" and the Difference is
 * never computed from nothing.
 */
function HeldKey({ orgName }: { orgName: string }) {
  const t = useTranslations("organization.modelFunding.funding");
  const rows = [
    "secret",
    "provisionedId",
    "accountName",
    "minted",
    "cap",
    "reads",
    "engine",
  ] as const;
  return (
    <div className="flex flex-col gap-3">
      <dl className={facts}>
        {rows.map((row) => (
          <div key={row} className="contents">
            <dt className={term}>{t(`facts.${row}`)}</dt>
            <dd>
              <NotRecordedValue />
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <StubDialog
          open={t("minted.rotate.open")}
          title={t("minted.rotate.title")}
          body={t("minted.rotate.body")}
          testId="funding-rotate-key"
        />
        <StubDialog
          open={t("minted.revoke.open")}
          title={t("minted.revoke.title")}
          body={t("minted.revoke.body", { org: orgName })}
          testId="funding-revoke-key"
        />
      </div>
      <Reconciliation />
    </div>
  );
}

function Reconciliation() {
  const t = useTranslations("organization.modelFunding.funding.reconciliation");
  return (
    <section
      aria-labelledby="funding-reconciliation"
      data-reconciliation=""
      data-issue="4005"
      className="border-t border-border pt-3"
    >
      <h4
        id="funding-reconciliation"
        className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-dim"
      >
        {t("title")}
      </h4>
      <dl className={facts}>
        <dt className={term}>{t("provider")}</dt>
        <dd>
          <NotRecordedValue />
        </dd>
        <dt className={term}>{t("ledger")}</dt>
        <dd>
          <NotRecordedValue />
        </dd>
        <dt className={term}>{t("difference")}</dt>
        <dd>
          <NotRecordedValue />
        </dd>
      </dl>
      <p className={`${note} mt-2.5`}>{t("note")}</p>
    </section>
  );
}

/** platform: Oxagen's shared key, which has nothing of its own to show. */
function SharedKey() {
  const t = useTranslations("organization.modelFunding.funding");
  return (
    <dl className={facts}>
      <dt className={term}>{t("facts.key")}</dt>
      <dd>{t("shared.key")}</dd>
      <dt className={term}>{t("facts.billing")}</dt>
      <dd>{t("shared.billing")}</dd>
    </dl>
  );
}

/** Change source (the `funding` dialog): the three sources, what each means, and which is current. */
function ChangeSource({ current }: { current: FundingSource | null }) {
  const t = useTranslations("organization.modelFunding.funding");
  return (
    <DetailsDialog
      open={t("change.open")}
      title={t("change.title")}
      testId="funding-change-source"
    >
      <ul className="flex flex-col gap-2.5">
        {FUNDING_SOURCES.map((source) => (
          <li
            key={source}
            data-source-option={source}
            className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2.5"
          >
            <span className="flex flex-wrap items-center gap-2">
              <b className={mono}>{source}</b>
              {source === current ? (
                <Badge tone="allowed">{t("change.current")}</Badge>
              ) : null}
              {source === "platform_minted" ? (
                <Badge tone="quiet" dot={false}>
                  {t("change.reconciles")}
                </Badge>
              ) : null}
            </span>
            <span className="text-[12.5px] text-muted-foreground">
              <b className="text-foreground">
                {t(`sources.${source}.summary`)}
              </b>{" "}
              {t(`sources.${source}.about`)}
            </span>
          </li>
        ))}
      </ul>
      <p className={`${note} mt-3`}>{t("change.note")}</p>
    </DetailsDialog>
  );
}

/** Model routes for Oxagen's own work: the four tiers, with nothing stored per organization yet (#4006). */
function ModelRoutes() {
  const t = useTranslations("organization.modelFunding.routes");
  return (
    <section
      aria-labelledby="org-model-routes"
      className={panel}
      data-issue="4006"
    >
      <div className={panelHeader}>
        {/* The design's badge carried two facts joined by a comma; a label
            states one, so the fact is a caption and the second is the note's. */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="org-model-routes" className={panelTitle}>
            {t("title")}
          </h2>
          <span className="text-xs text-dim" data-caption="">
            {t("caption")}
          </span>
        </div>
      </div>
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.tier") },
          { label: t("columns.provider") },
          { label: t("columns.route") },
          { label: t("columns.fallback") },
          { label: t("columns.use"), numeric: true },
          { label: t("columns.cost"), numeric: true },
          { label: t("columns.edit"), hidden: true },
        ]}
      >
        {TIERS.map((tier) => (
          <tr key={tier} data-route={tier}>
            <td className={cell}>
              <span className={mono}>{tier}</span>
              <div className="max-w-[34ch] text-[11px] text-dim">
                {t(`tiers.${tier}`)}
              </div>
            </td>
            <td className={cell}>
              <NotRecordedValue />
            </td>
            <td className={cell}>
              <NotRecordedValue />
            </td>
            <td className={cell}>
              <NotRecordedValue />
            </td>
            <td className={numericCell}>
              <NotRecordedValue />
            </td>
            <td className={numericCell}>
              <NotRecordedValue />
            </td>
            <td className={cell}>
              <StubDialog
                open={t("edit.open")}
                title={t("edit.title", { tier })}
                body={t("edit.body")}
                testId={`edit-route-${tier}`}
              />
            </td>
          </tr>
        ))}
        <tr data-route-total="">
          <td className={cell} colSpan={5}>
            <b>{t("total")}</b>{" "}
            <span
              className="text-[11.5px] text-dim"
              data-basis="client_attested"
            >
              {t("basis")}
            </span>{" "}
            <span className="text-[11.5px] text-dim">{t("currency")}</span>
          </td>
          <td className={numericCell}>
            <NotRecordedValue />
          </td>
          <td className={cell} />
        </tr>
      </Table>
      <div className={`${panelBody} flex flex-col gap-2`}>
        <p className={note}>{t("harnesses")}</p>
        <p className={note}>{t("unrecorded")}</p>
      </div>
    </section>
  );
}
