import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RunWork as RunWorkView } from "@/data/contracts/run-work";
import { PAGE_FAILURES, readError, type Read } from "@/data/read";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { parseGitHubUrl } from "@/shared/github-url";
import { routes } from "@/shared/safe-path";
import { GitHubLink, SafeLink } from "@/ui/navigation";
import { panel, mono } from "@/ui/control-styles";
import { ReadFailure } from "@/ui/read-failure";
import { CopyLocation } from "./copy-location";

const FAILURE = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
]);
function ProviderLink({
  url,
  children,
}: {
  url: string | null;
  children: ReactNode;
}) {
  const target = parseGitHubUrl(url);
  return target ? (
    <GitHubLink to={target} className="underline underline-offset-4">
      {children}
    </GitHubLink>
  ) : (
    <span>{children}</span>
  );
}
export function RunWorkSection({
  read,
  org,
  ws,
  runId,
}: {
  read: Read<RunWorkView>;
  org: string;
  ws: string;
  runId: string;
}) {
  const t = useTranslations("run.work");
  if (!read.ok) return <ReadFailure read={read} section={t("title")} />;
  const value = read.value;
  const failures = value.pullRequests.flatMap((pr) =>
    (pr.ci?.runs ?? [])
      .filter((check) => check.conclusion && FAILURE.has(check.conclusion))
      .map((check) => ({ pr, check })),
  );
  return (
    <section
      aria-label={t("title")}
      className={`${panel} flex flex-col gap-5 p-4`}
      data-testid="run-work"
    >
      <div>
        <h2 className="font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("basis")}</p>
      </div>
      {failures.length > 0 && (
        <div
          className="rounded-md border border-destructive p-3"
          data-testid="run-ci-failures"
        >
          <h3 className="font-semibold text-destructive">
            {t("failedChecks", { count: failures.length })}
          </h3>
          <ul className="mt-2 space-y-2 text-sm">
            {failures.map(({ pr, check }, index) => (
              <li key={`${pr.repository.url}/${pr.number}/${index}`}>
                <ProviderLink url={check.url}>{check.name}</ProviderLink>
                {" · "}
                <ProviderLink url={pr.url}>
                  {pr.repository.owner}/{pr.repository.name} #{pr.number}
                </ProviderLink>
                {!pr.current && (
                  <span className="text-muted-foreground"> · {t("stale")}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">{t("checkouts")}</h3>
          <p className="text-xs text-muted-foreground">
            {value.machine
              ? t("onMachine", { name: value.machine.name })
              : t("machineMissing")}
          </p>
          {value.checkouts.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t("locationMissing")}
            </p>
          ) : (
            <ul className="mt-2 space-y-4">
              {value.checkouts.map((checkout) => (
                <li key={checkout.ref}>
                  <code className={`${mono} block break-all text-xs`}>
                    {checkout.path}
                  </code>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {checkout.repository?.url ?? t("repoMissing")} ·{" "}
                    {checkout.branch ?? t("branchMissing")}
                  </p>
                  {checkout.headSha && (
                    <code
                      className={`${mono} block break-all text-xs text-muted-foreground`}
                    >
                      {checkout.headSha}
                    </code>
                  )}
                  <CopyLocation path={checkout.path} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-sm font-semibold">{t("pullRequests")}</h3>
          {value.pullRequests.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t("prMissing")}
            </p>
          ) : (
            <ul className="mt-2 space-y-3">
              {value.pullRequests.map((pr) => (
                <li key={`${pr.repository.url}/${pr.number}`}>
                  <ProviderLink url={pr.url}>
                    {pr.repository.owner}/{pr.repository.name} #{pr.number}:{" "}
                    {pr.title}
                  </ProviderLink>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(`association.${pr.association}`)} ·{" "}
                    {pr.ci ? t(`ci.${pr.ci.overall}`) : t("ciMissing")}
                    {!pr.current ? ` · ${t("stale")}` : ""}
                  </p>
                  {pr.ci && (
                    <p className="text-xs text-muted-foreground">
                      {t("checkCounts", {
                        passed: pr.ci.counts.passed,
                        failed: pr.ci.counts.failed,
                        pending: pr.ci.counts.pending,
                      })}
                      {!pr.ci.complete ? ` · ${t("checksPartial")}` : ""}
                    </p>
                  )}
                  {pr.diff && (
                    <p className="text-xs text-muted-foreground">
                      {t("diffFiles", { count: pr.diff.files.length })} ·{" "}
                      {pr.diff.complete ? t("diffComplete") : t("diffPartial")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          {t("evidence", { count: value.diffs.length })}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">{t("diffBasis")}</p>
        {value.diffs.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("diffMissing")}
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {value.diffs.map((diff) => (
              <li key={diff.seq} className="text-xs">
                <SafeLink
                  to={routes.run(org, ws, runId, {
                    tab: "frames",
                    body: diff.seq,
                  })}
                  className="underline underline-offset-4"
                >
                  {t("frame", { seq: diff.seq })}
                </SafeLink>
                {" · "}
                {t(`capture.${diff.completeness}`)}
                <code
                  className={`${mono} block break-all text-muted-foreground`}
                >
                  {diff.digest}
                </code>
                {diff.limitations.length > 0 && (
                  <p className="text-muted-foreground">
                    {diff.limitations.join(", ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
      {!value.complete && (
        <p className="text-xs text-muted-foreground" role="status">
          {t("incomplete")}
        </p>
      )}
    </section>
  );
}

/** Provider latency stays inside this section's streaming boundary. */
export async function RunWork({
  ctx,
  source,
  ...place
}: {
  ctx: WsCtx;
  source: DataSource;
  org: string;
  ws: string;
  runId: string;
}) {
  const read = await source.runs
    .work(ctx, place.runId)
    .catch(() =>
      readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
    );
  return <RunWorkSection read={read} {...place} />;
}

export function RunWorkLoading() {
  const t = useTranslations("run.work");
  return (
    <section
      className={`${panel} p-4`}
      aria-label={t("title")}
      aria-busy="true"
    >
      <p role="status" className="text-sm text-muted-foreground">
        {t("loading")}
      </p>
    </section>
  );
}
