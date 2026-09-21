import { useTranslations } from "next-intl";
import type { RunProof } from "@/data/contracts/run-proof";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Fact, Facts, NoValue, Panel } from "./parts";

export function ProofSection({
  read,
  org,
  ws,
}: {
  read: Read<RunProof>;
  org: string;
  ws: string;
}) {
  const t = useTranslations("run.proof");
  const format = useFormatter();
  if (!read.ok)
    return (
      <Panel title={t("title")}>
        <ReadFailure read={read} section={t("title")} />
      </Panel>
    );
  const proof = read.value;
  return (
    <Panel title={t("title")}>
      <div className="flex min-w-0 flex-col gap-5" data-testid="run-proof">
        <Facts>
          <Fact label={t("verdict")}>
            {proof.verdict === null ? (
              <NoValue />
            ) : (
              t(`verdicts.${proof.verdict}`)
            )}
          </Fact>
          <Fact label={t("disclosure")}>{proof.disclosureGrain}</Fact>
        </Facts>
        {proof.witnesses.length === 0 ? (
          <p
            data-testid="proof-empty"
            className="text-sm text-muted-foreground"
          >
            {t("empty")}
          </p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-4">
            {proof.witnesses.map((witness) => (
              <li
                key={witness.witnessId}
                className="min-w-0 rounded-lg border border-border p-3"
                data-testid="proof-witness"
              >
                <h4 className="break-all font-mono text-sm font-semibold">
                  {witness.witnessId}
                </h4>
                <Facts>
                  <Fact label={t("oracle")}>
                    {t(`oracles.${witness.oracle}`)}
                  </Fact>
                  <Fact label={t("heldOut")}>
                    {t(witness.heldOut ? "yes" : "no")}
                  </Fact>
                  <Fact label={t("verdict")}>
                    {t(`verdicts.${witness.verdict}`)}
                  </Fact>
                  <Fact label={t("commandDigest")} code>
                    {witness.commandDigest}
                  </Fact>
                </Facts>
                {witness.attempts.map((attempt) => (
                  <details
                    key={attempt.attemptNo}
                    className="mt-3 min-w-0 border-t border-border pt-3"
                  >
                    <summary className="cursor-pointer text-sm">
                      {t("attempt", { number: attempt.attemptNo })}:{" "}
                      {t(`verdicts.${attempt.verdict}`)}
                    </summary>
                    <div className="mt-3">
                      <Facts>
                        <Fact label={t("observedAt")}>
                          <time dateTime={attempt.observedAt}>
                            {format.dateTime(new Date(attempt.observedAt), {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </time>
                        </Fact>
                        <Fact label={t("frame")} code>
                          {attempt.frameSeq}
                        </Fact>
                        <Fact label={t("target")} code>
                          {attempt.targetRef} · {attempt.targetSha}
                        </Fact>
                        <Fact label={t("targetResult")}>
                          {t(`results.${attempt.targetResult}`)}
                        </Fact>
                        <Fact label={t("head")} code>
                          {attempt.prRef} · {attempt.prSha}
                        </Fact>
                        <Fact label={t("headResult")}>
                          {t(`results.${attempt.prResult}`)}
                        </Fact>
                        <Fact label={t("failFingerprint")} code>
                          {attempt.failFingerprint ?? <NoValue />}
                        </Fact>
                        <Fact label={t("passDigest")} code>
                          {attempt.passOutputDigest ?? <NoValue />}
                        </Fact>
                        <Fact label={t("tamper")}>
                          {t(`tamperStates.${attempt.tamperExclusion}`)}
                        </Fact>
                        {attempt.tamper !== null ? (
                          <>
                            <Fact label={t("authoredFingerprint")} code>
                              {attempt.tamper.fingerprintAuthored}
                            </Fact>
                            <Fact label={t("runFingerprint")} code>
                              {attempt.tamper.fingerprintAtRun}
                            </Fact>
                          </>
                        ) : null}
                        <Fact label={t("disclosure")}>
                          {attempt.disclosureGrain}
                        </Fact>
                        <Fact label={t("witnessRun")}>
                          {attempt.witnessRunId === null ? (
                            <NoValue />
                          ) : (
                            <SafeLink
                              className="break-all underline"
                              to={routes.run(org, ws, attempt.witnessRunId)}
                            >
                              {attempt.witnessRunId}
                            </SafeLink>
                          )}
                        </Fact>
                      </Facts>
                      <div
                        className="mt-3 rounded-md border border-border p-3"
                        data-testid="proof-attestation"
                      >
                        <h5 className="text-sm font-semibold">
                          {t("attestation")}
                        </h5>
                        <p className="mb-2 text-xs text-muted-foreground">
                          {t("attestationNote")}
                        </p>
                        <Facts>
                          <Fact label={t("key")} code>
                            {attempt.runnerAttestation.keyId}
                          </Fact>
                          <Fact label={t("signature")} code>
                            {attempt.runnerAttestation.signature}
                          </Fact>
                        </Facts>
                      </div>
                    </div>
                  </details>
                ))}
              </li>
            ))}
          </ul>
        )}
        {proof.witnessRuns.length > 0 ? (
          <section aria-label={t("witnessCosts")}>
            <h4 className="mb-2 text-sm font-semibold">{t("witnessCosts")}</h4>
            <ul className="flex flex-col gap-2 text-sm">
              {proof.witnessRuns.map((run) => (
                <li key={run.runId} className="flex flex-wrap gap-3">
                  <SafeLink
                    className="break-all underline"
                    to={routes.run(org, ws, run.runId)}
                  >
                    {run.runId}
                  </SafeLink>
                  {run.cost === null ? (
                    <NoValue />
                  ) : (
                    <span>
                      <Money value={run.cost} /> ·{" "}
                      {run.cost.basis === null
                        ? t("basisUnknown")
                        : t(`bases.${run.cost.basis}`)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Panel>
  );
}
