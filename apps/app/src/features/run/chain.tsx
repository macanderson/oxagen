// The Chain and seal tab (spec §8.3, §8.4; mockup `pRun`): what makes this
// recording tamper-evident, what it is missing, and how far it can be replayed.
//
// The grade is the one the seal recorded, and it is the only grade this tab
// states. The ladder under it is computed from what the read could see, so a
// rung can stand met while the recorded word is weaker; the panel says which
// is which rather than quietly showing the stronger of the two (§8.4: a badge
// that describes trust shows the recorded value and nothing stronger).
//
// A gap is a fact about the record, not a fault to soften. A run that dropped
// nine frames says so with the sequences it dropped, and a walk that stopped
// short says its gaps are a prefix's.
import { useLocale, useTranslations } from "next-intl";
import type { ChainCheckpoint, RunChain } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { mono } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { ReplayGradeBadge } from "@/ui/replay-grade";
import { cell, numericCell, Table } from "@/ui/table";
import { Fact, Facts, NoValue, Panel } from "./parts";
import type { RunTabProps } from "./tab-props";

function Gaps({
  gaps,
  complete,
}: {
  gaps: RunChain["gaps"];
  complete: boolean;
}) {
  const t = useTranslations("run.chain");
  const locale = useLocale();
  const clean =
    gaps.missingSequences.length === 0 &&
    gaps.missingBodies === 0 &&
    gaps.recorded.length === 0;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">{t("gapsTitle")}</h4>
      {complete ? null : (
        <p
          data-testid="chain-prefix"
          className="max-w-prose text-xs text-muted-foreground"
        >
          {t("prefix")}
        </p>
      )}
      {clean ? (
        <p
          data-testid="chain-no-gaps"
          className="max-w-prose text-sm text-muted-foreground"
        >
          {t("noGaps")}
        </p>
      ) : (
        <Facts>
          <Fact label={t("missingFrames")}>
            {formatCount(gaps.missingFrameCount, locale)}
          </Fact>
          <Fact label={t("missingBodies")}>
            {formatCount(gaps.missingBodies, locale)}
          </Fact>
          <Fact label={t("missingSequences")} code>
            {gaps.missingSequences.length === 0 ? (
              <NoValue />
            ) : (
              gaps.missingSequences
                .map((gap) =>
                  gap.from === gap.to ? gap.from : `${gap.from}-${gap.to}`,
                )
                .join(", ")
            )}
          </Fact>
          <Fact label={t("recordedGaps")}>
            {gaps.recorded.length === 0 ? (
              <NoValue />
            ) : (
              <ul
                data-testid="chain-recorded-gaps"
                className="flex flex-col gap-0.5"
              >
                {gaps.recorded.map((kind) => (
                  <li key={kind}>{t(`gap.${kind}`)}</li>
                ))}
              </ul>
            )}
          </Fact>
        </Facts>
      )}
    </div>
  );
}

function Checkpoints({
  checkpoints,
}: {
  checkpoints: readonly ChainCheckpoint[];
}) {
  const t = useTranslations("run.chain");
  const format = useFormatter();
  const locale = useLocale();
  if (checkpoints.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t("checkpointsTitle")}</h4>
        <p
          data-testid="chain-no-checkpoints"
          className="max-w-prose text-sm text-muted-foreground"
        >
          {t("noCheckpoints")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">{t("checkpointsTitle")}</h4>
      <Table
        label={t("checkpointsTitle")}
        columns={[
          { label: t("columns.seq"), numeric: true },
          { label: t("columns.head") },
          { label: t("columns.frames"), numeric: true },
          { label: t("columns.signed") },
          { label: t("columns.countersigned") },
          { label: t("columns.anchor") },
        ]}
      >
        {checkpoints.map((checkpoint) => (
          <tr key={checkpoint.chainHead} data-testid="chain-checkpoint">
            <td className={`${numericCell} ${mono}`}>{checkpoint.seq}</td>
            <td className={`${cell} ${mono} break-all text-[11px]`}>
              {checkpoint.chainHead}
              <span className="block text-muted-foreground">
                {checkpoint.deviceKeyFingerprint}
              </span>
            </td>
            <td className={numericCell}>
              {formatCount(checkpoint.eventCount, locale)}
            </td>
            <td className={cell}>
              <time dateTime={checkpoint.signedAt}>
                {format.dateTime(new Date(checkpoint.signedAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </td>
            <td className={cell}>
              {checkpoint.countersignedAt === null ? (
                <NoValue />
              ) : (
                <>
                  <time dateTime={checkpoint.countersignedAt}>
                    {format.dateTime(new Date(checkpoint.countersignedAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                  {checkpoint.platformKey === null ? null : (
                    <span
                      className={`${mono} block break-all text-[11px] text-muted-foreground`}
                    >
                      {checkpoint.platformKey}
                    </span>
                  )}
                </>
              )}
            </td>
            <td className={`${cell} ${mono} break-all text-[11px]`}>
              {checkpoint.anchorRoot ?? <NoValue />}
            </td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function Ladder({
  ladder,
  recordedGrade,
}: {
  ladder: RunChain["ladder"];
  recordedGrade: RunChain["recordedGrade"];
}) {
  const t = useTranslations("run.chain");
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">{t("ladderTitle")}</h4>
      <p className="max-w-prose text-xs text-muted-foreground">
        {recordedGrade === null ? t("ladderNoGrade") : t("ladderWhy")}
      </p>
      <ul data-testid="chain-ladder" className="flex flex-col gap-1.5">
        {ladder.map((rung) => (
          <li
            key={rung.grade}
            data-testid="chain-rung"
            data-met={rung.met ? "true" : "false"}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
          >
            <span className="font-medium">{t(`grade.${rung.grade}`)}</span>
            <span className="text-xs text-muted-foreground">
              {rung.met ? t("rungMet") : t("rungUnmet")}
            </span>
            <span
              className={`${mono} break-all text-[11px] text-muted-foreground`}
            >
              {rung.reason}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Seal({
  seal,
  attempt,
}: {
  seal: RunChain["seals"][number];
  /** Which attempt this is among a retried run's seals, 1-based; undefined for the only one. */
  attempt?: { n: number };
}) {
  const t = useTranslations("run.chain");
  const format = useFormatter();
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">
        {attempt === undefined
          ? t("sealTitle")
          : `${t("sealTitle")}: ${t("attemptLabel", { n: attempt.n })}`}
      </h4>
      <Facts>
        <Fact label={t("sealedAt")}>
          <time dateTime={seal.sealedAt}>
            {format.dateTime(new Date(seal.sealedAt), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </time>
        </Fact>
        <Fact label={t("terminalStatus")} code>
          {seal.terminalStatus}
        </Fact>
        <Fact label={t("sealedFrames")}>
          {formatCount(seal.eventCount, locale)}
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
        <Fact label={t("merkleRoot")} code>
          {seal.merkleRoot ?? <NoValue />}
        </Fact>
        <Fact label={t("archive")} code>
          {seal.archiveSegmentRef ?? <NoValue />}
        </Fact>
      </Facts>
    </div>
  );
}

export function ChainSection({ read }: { read: Read<RunChain> }) {
  const t = useTranslations("run.chain");
  const locale = useLocale();
  return (
    <Panel
      title={t("title")}
      aside={
        read.ok && read.value.recordedGrade !== null ? (
          <ReplayGradeBadge grade={read.value.recordedGrade} />
        ) : undefined
      }
    >
      {!read.ok ? (
        <ReadFailure read={read} section={t("title")} />
      ) : (
        <div className="flex flex-col gap-5">
          <Facts>
            <Fact label={t("hashRule")} code>
              {read.value.hashRule}
            </Fact>
            <Fact label={t("frameCount")}>
              {formatCount(read.value.frameCount, locale)}
            </Fact>
            <Fact label={t("range")} code>
              {read.value.firstSeq === null || read.value.lastSeq === null ? (
                <NoValue />
              ) : (
                `${read.value.firstSeq}-${read.value.lastSeq}`
              )}
            </Fact>
            <Fact label={t("merkleRoot")} code>
              {read.value.merkleRoot ?? <NoValue />}
            </Fact>
            <Fact label={t("tierLabel")}>
              {/*
                The same badge Fleet's Tier column and the Run header draw. The
                seal's tier is the run's tier, so three copies of the closed
                vocabulary (ADR-095) were three places it could drift.
              */}
              <EnforcementTierBadge tier={read.value.enforcementTier} />
            </Fact>
            <Fact label={t("gradeLabel")}>
              {read.value.recordedGrade === null ? (
                <NoValue />
              ) : (
                t(`grade.${read.value.recordedGrade}`)
              )}
            </Fact>
          </Facts>
          <Gaps gaps={read.value.gaps} complete={read.value.complete} />
          {read.value.seals.length === 0 ? (
            <p
              data-testid="chain-unsealed"
              className="max-w-prose text-sm text-muted-foreground"
            >
              {t("unsealed")}
            </p>
          ) : (
            <div className="flex flex-col gap-5" data-testid="chain-seals">
              {read.value.seals.map((seal, i) => (
                <Seal
                  key={`${seal.sealedAt}-${String(i)}`}
                  seal={seal}
                  attempt={
                    read.value.seals.length > 1 ? { n: i + 1 } : undefined
                  }
                />
              ))}
            </div>
          )}
          <Checkpoints checkpoints={read.value.checkpoints} />
          <Ladder
            ladder={read.value.ladder}
            recordedGrade={read.value.recordedGrade}
          />
        </div>
      )}
    </Panel>
  );
}

/** The Chain and seal tab: the one tab that reads the chain. */
export async function ChainTab({ ctx, source, run }: RunTabProps) {
  return <ChainSection read={await source.runs.chain(ctx, run.id)} />;
}
