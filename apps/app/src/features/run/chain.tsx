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
import type { ReactNode } from "react";
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
  const when = (at: string) =>
    format.dateTime(new Date(at), { dateStyle: "medium", timeStyle: "short" });
  return (
    <Panel title={t("checkpointsTitle")}>
      {checkpoints.length === 0 ? (
        <p
          data-testid="chain-no-checkpoints"
          className="max-w-prose text-sm text-muted-foreground"
        >
          {t("noCheckpoints")}
        </p>
      ) : (
        <Table
          label={t("checkpointsTitle")}
          columns={[
            { label: t("columns.frame"), numeric: true },
            { label: t("columns.head") },
            { label: t("columns.covers"), numeric: true },
            { label: t("columns.signature") },
          ]}
        >
          {checkpoints.map((checkpoint) => (
            <tr key={checkpoint.chainHead} data-testid="chain-checkpoint">
              <td className={`${numericCell} ${mono}`}>{checkpoint.seq}</td>
              <td className={`${cell} ${mono} break-all text-[11px]`}>
                {checkpoint.chainHead}
              </td>
              <td className={numericCell}>
                {t("covers", {
                  count: formatCount(checkpoint.eventCount, locale),
                })}
              </td>
              <td className={`${cell} text-xs`}>
                <span className="flex flex-col gap-0.5">
                  <span>
                    {t("signedBy", {
                      key: checkpoint.deviceKeyFingerprint,
                    })}{" "}
                    <time dateTime={checkpoint.signedAt}>
                      {when(checkpoint.signedAt)}
                    </time>
                  </span>
                  {checkpoint.countersignedAt === null ? (
                    <span className="text-muted-foreground">
                      {t("notCountersigned")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {t("countersignedBy", {
                        key: checkpoint.platformKey ?? t("keyNotRecorded"),
                      })}{" "}
                      <time dateTime={checkpoint.countersignedAt}>
                        {when(checkpoint.countersignedAt)}
                      </time>
                    </span>
                  )}
                  {checkpoint.anchorRoot === null ? null : (
                    <span
                      className={`${mono} break-all text-[11px] text-muted-foreground`}
                    >
                      {t("anchor", { root: checkpoint.anchorRoot })}
                    </span>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function ReplayGrade({
  ladder,
  recordedGrade,
}: {
  ladder: RunChain["ladder"];
  recordedGrade: RunChain["recordedGrade"];
}) {
  const t = useTranslations("run.chain");
  return (
    <Panel
      title={t("gradeTitle")}
      aside={
        recordedGrade === null ? undefined : (
          <ReplayGradeBadge grade={recordedGrade} />
        )
      }
    >
      <p className="max-w-prose pb-3 text-xs text-muted-foreground">
        {recordedGrade === null ? t("ladderNoGrade") : t("ladderWhy")}
      </p>
      <Table
        label={t("gradeTitle")}
        columns={[
          { label: t("columns.grade") },
          { label: t("columns.recorded") },
          { label: t("columns.allows") },
        ]}
      >
        {ladder.map((rung) => (
          <tr
            key={rung.grade}
            data-testid="chain-rung"
            data-met={rung.met ? "true" : "false"}
          >
            <td className={cell}>
              <span className="font-medium">{t(`grade.${rung.grade}`)}</span>
              <span className="block text-xs text-muted-foreground">
                {rung.met ? t("rungMet") : t("rungUnmet")}
              </span>
            </td>
            <td className={`${cell} ${mono} break-all text-[11px]`}>
              {rung.reason}
            </td>
            <td className={`${cell} text-xs`}>{t(`allows.${rung.grade}`)}</td>
          </tr>
        ))}
      </Table>
    </Panel>
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
          ? t("sealRecord")
          : t("attemptLabel", { n: attempt.n })}
      </h4>
      <Facts>
        <Fact label={t("signature")}>
          <NoValue />
        </Fact>
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

export function ChainSection({
  read,
  actions,
}: {
  read: Read<RunChain>;
  /**
   * The tab's foot (spec: Fork replay from frame N, Bisect against another
   * run, Export the bundle), given the chain's last seq for the fork label.
   */
  actions?: (lastSeq: string | null) => ReactNode;
}) {
  const t = useTranslations("run.chain");
  const locale = useLocale();
  if (!read.ok) {
    return (
      <Panel title={t("title")}>
        <ReadFailure read={read} section={t("title")} />
      </Panel>
    );
  }
  const chain = read.value;
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("hashTitle")}>
        <div className="flex flex-col gap-5">
          <Facts>
            <Fact label={t("frameCount")}>
              {formatCount(chain.frameCount, locale)}
              {chain.firstSeq === null || chain.lastSeq === null ? null : (
                <span className={`${mono} ml-2 text-xs text-muted-foreground`}>
                  {t("rangeValue", {
                    from: chain.firstSeq,
                    to: chain.lastSeq,
                  })}
                </span>
              )}
            </Fact>
            <Fact label={t("hashRule")} code>
              {chain.hashRule}
            </Fact>
            <Fact label={t("telemetryGap")}>
              {chain.gaps.recorded.includes("telemetry_gap")
                ? t("telemetryGapRecorded")
                : t("telemetryGapNone")}
            </Fact>
          </Facts>
          <Gaps gaps={chain.gaps} complete={chain.complete} />
        </div>
      </Panel>
      <Panel title={t("sealTitle")}>
        <div className="flex flex-col gap-5">
          <Facts>
            <Fact label={t("merkleRoot")} code>
              {chain.merkleRoot ?? <NoValue />}
            </Fact>
            <Fact label={t("tierLabel")}>
              {/*
                The same badge Fleet's Tier column and the Run header draw. The
                seal's tier is the run's tier, so three copies of the closed
                vocabulary (ADR-095) were three places it could drift.
              */}
              <EnforcementTierBadge tier={chain.enforcementTier} />
            </Fact>
            <Fact label={t("verify")}>
              <span className="text-muted-foreground">{t("verifyHow")}</span>
            </Fact>
          </Facts>
          {chain.seals.length === 0 ? (
            <p
              data-testid="chain-unsealed"
              className="max-w-prose text-sm text-muted-foreground"
            >
              {t("unsealed")}
            </p>
          ) : (
            <div className="flex flex-col gap-5" data-testid="chain-seals">
              {chain.seals.map((seal, i) => (
                <Seal
                  key={`${seal.sealedAt}-${String(i)}`}
                  seal={seal}
                  attempt={chain.seals.length > 1 ? { n: i + 1 } : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </Panel>
      <ReplayGrade ladder={chain.ladder} recordedGrade={chain.recordedGrade} />
      <Checkpoints checkpoints={chain.checkpoints} />
      {actions === undefined ? null : (
        <div data-testid="chain-actions">{actions(chain.lastSeq)}</div>
      )}
    </div>
  );
}
