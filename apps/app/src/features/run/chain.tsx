// The Chain and seal tab (mockup `chainTab`; pages/run.md, Chain and seal;
// spec §8.3, §8.4): what makes this recording tamper-evident, what it is
// missing, how far it can be replayed, and the three actions that read it:
// fork replay, bisect and export.
//
// Four panels over `get_run_chain`, the one read this tab makes: Hash chain,
// Seal and attestation, Replay grade and Checkpoints. The grade is the one the
// seal recorded, and it is the only grade this tab states; the ladder under it
// is computed from what the read could see, so a rung can stand reached while
// the recorded word is weaker, and the table says which is which (§8.4). The
// seal's signature and the fields it signs over are not in the chain read, so
// those rows say not recorded.
//
// A gap is a fact about the record, not a fault to soften: a run that dropped
// nine frames says so with the sequences it dropped, and a walk that stopped
// short says its gaps are a prefix's.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { ChainCheckpoint, RunChain } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { Fact, Facts, Note, NoValue, Panel, PanelBody } from "./parts";
import { FrameLink } from "./policy-tab";
import { ExportAction } from "./record-actions";
import { BisectDialog, ForkAction } from "./replay-actions";
import type { Place, RunTabProps } from "./tab-props";

type Seal = RunChain["seals"][number];

/**
 * `table.narrow`: a table inside a half-width panel keeps the list table's
 * rows and header but drops its minimum width, so its columns wrap rather
 * than scroll.
 */
const narrowTable = "[&_table]:min-w-0";

/** A chain head in a narrow column: its first 8 hex digits. The whole head is the cell's title. */
function shortDigest(digest: string) {
  return `${digest.slice(digest.indexOf(":") + 1, digest.indexOf(":") + 9)}…`;
}

/** The hash rule's short name, for its message key. */
const RULE_KEY: Record<RunChain["hashRule"], "tacho" | "ledger"> = {
  "tacho.sha256_prev_hash_v1": "tacho",
  "ledger.event_stream_digest_v1": "ledger",
};

function isClean(gaps: RunChain["gaps"]) {
  return (
    gaps.missingSequences.length === 0 &&
    gaps.missingBodies === 0 &&
    gaps.recorded.length === 0
  );
}

function When({ at }: { at: string }) {
  const format = useFormatter();
  return (
    <time dateTime={at}>
      {format.dateTime(new Date(at), {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </time>
  );
}

function Gaps({ gaps }: { gaps: RunChain["gaps"] }) {
  const t = useTranslations("run.chain.hash");
  const tGap = useTranslations("run");
  const locale = useLocale();
  if (isClean(gaps))
    return <span data-testid="chain-no-gaps">{t("gapsNone")}</span>;
  return (
    <ul
      data-testid="chain-gaps"
      className="m-0 flex list-none flex-col gap-0.5 p-0"
    >
      {gaps.missingFrameCount === 0 ? null : (
        <li>
          {t("missingFrames", {
            count: formatCount(gaps.missingFrameCount, locale),
          })}{" "}
          <span className={`${mono} text-[11.5px]`}>
            {gaps.missingSequences
              .map((gap) =>
                gap.from === gap.to ? gap.from : `${gap.from}-${gap.to}`,
              )
              .join(", ")}
          </span>
        </li>
      )}
      {gaps.missingBodies === 0 ? null : (
        <li>
          {t("missingBodies", {
            count: formatCount(gaps.missingBodies, locale),
          })}
        </li>
      )}
      {gaps.recorded.map((kind) => (
        <li key={kind} data-testid="chain-recorded-gap">
          {tGap(`gap.${kind}`)}
        </li>
      ))}
    </ul>
  );
}

function HashChain({ chain }: { chain: RunChain }) {
  const t = useTranslations("run.chain.hash");
  const locale = useLocale();
  const clean = isClean(chain.gaps);
  const sealed = chain.seals.length > 0;
  const countersigned = chain.checkpoints.filter(
    (checkpoint) => checkpoint.countersignedAt !== null,
  ).length;
  const rule = RULE_KEY[chain.hashRule];
  return (
    <Panel
      title={t("title")}
      testId="chain-hash"
      aside={
        !clean ? (
          <Badge tone="denied">{t("gapsFound")}</Badge>
        ) : chain.complete ? (
          <Badge tone="allowed">{t("clean")}</Badge>
        ) : (
          <Badge tone="quiet">{t("cleanPart")}</Badge>
        )
      }
    >
      <Facts>
        <Fact label={t("frames")}>
          {chain.firstSeq === null || chain.lastSeq === null
            ? t("framesCount", { count: formatCount(chain.frameCount, locale) })
            : t("framesRange", {
                count: formatCount(chain.frameCount, locale),
                first: chain.firstSeq,
                last: chain.lastSeq,
              })}
        </Fact>
        <Fact label={t("rule")}>
          <span className={`${mono} block text-[11.5px]`}>
            {t(`rules.${rule}`)}
          </span>
          <span className={`${mono} block text-[11px] text-dim`}>
            {chain.hashRule}
          </span>
        </Fact>
        <Fact label={t("telemetry")}>
          {!sealed
            ? t("telemetryUnsealed")
            : chain.gaps.recorded.includes("telemetry_gap")
              ? t("telemetryRecorded")
              : t("telemetryNone")}
        </Fact>
        <Fact label={t("checkpoints")}>
          {chain.checkpoints.length === 0
            ? t(`checkpointsNone.${rule}`)
            : t("checkpointsValue", {
                count: formatCount(chain.checkpoints.length, locale),
                countersigned: formatCount(countersigned, locale),
              })}
        </Fact>
        <Fact label={t("completeness")}>
          <Gaps gaps={chain.gaps} />
        </Fact>
      </Facts>
      <div className="mt-[13px] flex flex-col gap-2">
        <Note>{t(`note.${rule}`)}</Note>
        {chain.complete ? null : (
          <p
            data-testid="chain-prefix"
            className="m-0 text-xs text-muted-foreground"
          >
            {t("prefix")}
          </p>
        )}
      </div>
    </Panel>
  );
}

/** One seal's recorded fields. */
function SealFacts({ seal }: { seal: Seal }) {
  const t = useTranslations("run.chain.seal");
  const locale = useLocale();
  return (
    <>
      <Fact label={t("sealedAt")}>
        <When at={seal.sealedAt} />
      </Fact>
      <Fact label={t("terminalStatus")} code>
        {seal.terminalStatus}
      </Fact>
      <Fact label={t("over")}>
        {t("overValue", { count: formatCount(seal.eventCount, locale) })}
      </Fact>
      <Fact label={t("finalSeq")} code>
        {seal.finalRunSeq ?? <NoValue />}
      </Fact>
      <Fact label={t("finalDigest")} code>
        {seal.finalEventDigest ?? <NoValue />}
      </Fact>
      <Fact label={t("streamDigest")} code>
        {seal.eventStreamDigest ?? <NoValue />}
      </Fact>
    </>
  );
}

function SealPanel({
  chain,
  run,
  place,
  orgRole,
}: {
  chain: RunChain;
  run: RunRow;
  place: Place;
  orgRole: OrgRole;
}) {
  const t = useTranslations("run.chain.seal");
  const latest = chain.seals.at(-1);
  return (
    <Panel
      title={t("title")}
      testId="chain-seal"
      aside={
        latest === undefined ? undefined : (
          <Badge tone="allowed">{t("sealed")}</Badge>
        )
      }
    >
      {latest === undefined ? (
        <p
          data-testid="chain-unsealed"
          className="m-0 text-[13px] text-muted-foreground"
        >
          {t("unsealed")}
        </p>
      ) : (
        <div className="flex flex-col gap-4" data-testid="chain-seals">
          <Facts>
            <Fact label={t("signature")}>
              <span title={t("notInRead")}>
                <NoValue />
              </span>
            </Fact>
            <Fact label={t("signsOver")}>
              <span title={t("notInRead")}>
                <NoValue />
              </span>
            </Fact>
            <Fact label={t("merkleRoot")} code>
              {latest.merkleRoot ?? chain.merkleRoot ?? <NoValue />}
            </Fact>
            <Fact label={t("tier")}>
              {/*
                The same badge Fleet's Tier column and the Run header draw: the
                seal's tier is the run's tier, one closed vocabulary (ADR-095).
              */}
              <EnforcementTierBadge tier={chain.enforcementTier} />
            </Fact>
            <Fact label={t("archive")} code>
              {latest.archiveSegmentRef ?? <NoValue />}
            </Fact>
            {chain.seals.length === 1 ? <SealFacts seal={latest} /> : null}
            <Fact label={t("verify")}>
              <ExportAction
                org={place.org}
                ws={place.ws}
                runId={run.id}
                sealed={run.status !== "live"}
                orgRole={orgRole}
                label={t("export")}
                testId="chain-export"
              />
            </Fact>
          </Facts>
          {chain.seals.length === 1
            ? null
            : chain.seals.map((seal, i) => (
                <div
                  key={`${seal.sealedAt}-${String(i)}`}
                  data-testid="chain-attempt"
                >
                  <h4 className="mb-2 text-[12.5px] font-semibold">
                    {t("attempt", { n: i + 1 })}
                  </h4>
                  <Facts>
                    <SealFacts seal={seal} />
                    <Fact label={t("merkleRoot")} code>
                      {seal.merkleRoot ?? <NoValue />}
                    </Fact>
                  </Facts>
                </div>
              ))}
        </div>
      )}
    </Panel>
  );
}

function ReplayGrade({
  chain,
  run,
  place,
  fromSeq,
}: {
  chain: RunChain;
  run: RunRow;
  place: Place;
  fromSeq: string | null;
}) {
  const t = useTranslations("run.chain.grade");
  const tReplay = useTranslations("run.replay");
  const recorded = chain.recordedGrade;
  return (
    <Panel
      title={t("title")}
      testId="chain-grade"
      flush
      aside={
        recorded === null ? (
          <Badge tone="quiet" dot={false}>
            {t("noGrade")}
          </Badge>
        ) : (
          <Badge tone="quiet" dot={false} data-grade={recorded}>
            {recorded}
          </Badge>
        )
      }
    >
      <div className={narrowTable}>
        <Table
          label={t("title")}
          columns={[
            { label: t("grade") },
            { label: t("recorded") },
            { label: t("allows") },
          ]}
        >
          {chain.ladder.map((rung) => (
            <tr
              key={rung.grade}
              data-testid="chain-rung"
              data-met={rung.met ? "true" : "false"}
              data-recorded={rung.grade === recorded ? "true" : undefined}
              className={rung.grade === recorded ? "bg-hl" : undefined}
            >
              <td className={cell}>
                {rung.grade === recorded ? (
                  <Badge tone="proven">{rung.grade}</Badge>
                ) : (
                  <span className={`${mono} text-dim`}>{rung.grade}</span>
                )}
              </td>
              <td className={`${cell} text-xs`}>
                <span className="block">
                  {rung.met ? t("met") : t("unmet")}
                </span>
                <span
                  className={`${mono} block break-all text-[11px] text-dim`}
                >
                  {rung.reason}
                </span>
              </td>
              <td className={`${cell} text-xs`}>
                {t(`allowsText.${rung.grade}`)}
              </td>
            </tr>
          ))}
        </Table>
      </div>
      <PanelBody>
        <Note>{recorded === null ? t("whyNoGrade") : t("why")}</Note>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {run.status === "live" ? null : (
            <BisectDialog
              org={place.org}
              ws={place.ws}
              runId={run.id}
              label={tReplay("bisectAgainst")}
              testId="chain-bisect"
            />
          )}
          <ForkAction
            org={place.org}
            ws={place.ws}
            run={run}
            label={
              fromSeq === null
                ? tReplay("forkAny")
                : tReplay("forkFrom", { seq: fromSeq })
            }
            testId="chain-fork"
            fromSeq={fromSeq ?? undefined}
          />
        </div>
      </PanelBody>
    </Panel>
  );
}

function Checkpoints({ chain, place }: { chain: RunChain; place: Place }) {
  const t = useTranslations("run.chain.checkpoints");
  const locale = useLocale();
  const rule = RULE_KEY[chain.hashRule];
  return (
    <Panel
      title={t("title")}
      testId="chain-checkpoints"
      flush
      aside={
        <span className="font-mono text-[11px] text-dim">
          {t("count", { count: formatCount(chain.checkpoints.length, locale) })}
        </span>
      }
    >
      {chain.checkpoints.length === 0 ? (
        <PanelBody>
          <p
            data-testid="chain-no-checkpoints"
            className="m-0 text-[12.5px] text-muted-foreground"
          >
            {t(`none.${rule}`)}
          </p>
        </PanelBody>
      ) : (
        <div className={narrowTable}>
          <Table
            label={t("title")}
            columns={[
              { label: t("frame") },
              { label: t("head") },
              { label: t("covers"), numeric: true },
              { label: t("signature") },
            ]}
          >
            {chain.checkpoints.map((checkpoint) => (
              <CheckpointRow
                key={checkpoint.chainHead}
                checkpoint={checkpoint}
                place={place}
              />
            ))}
          </Table>
        </div>
      )}
    </Panel>
  );
}

function CheckpointRow({
  checkpoint,
  place,
}: {
  checkpoint: ChainCheckpoint;
  place: Place;
}) {
  const t = useTranslations("run.chain.checkpoints");
  const locale = useLocale();
  return (
    <tr data-testid="chain-checkpoint">
      <td className={cell}>
        <FrameLink seq={checkpoint.seq} chainRef={undefined} place={place} />
      </td>
      <td
        className={`${cell} ${mono} whitespace-nowrap text-[11px]`}
        title={checkpoint.chainHead}
      >
        {shortDigest(checkpoint.chainHead)}
      </td>
      <td className={numericCell}>
        {formatCount(checkpoint.eventCount, locale)}
      </td>
      <td className={`${cell} text-xs`}>
        <span className="flex flex-col items-start gap-1">
          {checkpoint.countersignedAt === null ? (
            <span data-testid="chain-not-countersigned">
              <Badge tone="quiet" dot={false}>
                {t("notCountersigned")}
              </Badge>
            </span>
          ) : (
            <Badge tone="allowed">{t("countersigned")}</Badge>
          )}
          <span className="text-[11px] text-dim">
            {t("signed")} <When at={checkpoint.signedAt} />
            <span className={`${mono} block break-all`}>
              {checkpoint.deviceKeyFingerprint}
            </span>
          </span>
          {checkpoint.countersignedAt === null ? null : (
            <span className="text-[11px] text-dim">
              {t("countersignedAt")} <When at={checkpoint.countersignedAt} />
              {checkpoint.platformKey === null ? null : (
                <span className={`${mono} block break-all`}>
                  {checkpoint.platformKey}
                </span>
              )}
            </span>
          )}
          {checkpoint.anchorRoot === null ? null : (
            <span className={`${mono} break-all text-[11px] text-dim`}>
              {t("anchored", { root: checkpoint.anchorRoot })}
            </span>
          )}
        </span>
      </td>
    </tr>
  );
}

/**
 * The four panels over a chain read.
 *
 * @internal Exported for its unit test; the page renders it through ChainTab.
 */
export function ChainSection({
  read,
  run,
  place,
  orgRole,
  fromSeq,
}: {
  read: Read<RunChain>;
  run: RunRow;
  place: Place;
  orgRole: OrgRole;
  /** The frame the page has open (`?body=`), which Fork replay starts from. */
  fromSeq: string | null;
}) {
  const t = useTranslations("run.chain");
  if (!read.ok)
    return (
      <Panel title={t("title")} testId="chain-failure">
        <ReadFailure read={read} section={t("title")} />
      </Panel>
    );
  const chain = read.value;
  return (
    // `.grid.g2 { grid-template-columns:repeat(auto-fit,minmax(320px,1fr)) }`
    <div className="grid items-start gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
      <HashChain chain={chain} />
      <SealPanel chain={chain} run={run} place={place} orgRole={orgRole} />
      <ReplayGrade chain={chain} run={run} place={place} fromSeq={fromSeq} />
      <Checkpoints chain={chain} place={place} />
    </div>
  );
}

/** The Chain and seal tab: the one tab that reads the chain. */
export async function ChainTab(props: RunTabProps): Promise<ReactNode> {
  const { ctx, source, run, place, view } = props;
  const read = await source.runs.chain(ctx, run.id);
  return (
    <ChainSection
      read={read}
      run={run}
      place={place}
      orgRole={ctx.orgRole}
      fromSeq={view.body}
    />
  );
}
