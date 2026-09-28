// The steering repo card on the repositories page: the repository, its
// published version, and its health in one sentence. While the repo is not
// ready, provisioning takes the health row's place. When the read fails, the
// card says who was denied what, or which code the control plane answered.
// The async read is ./section.
import { useTranslations } from "next-intl";
import type { SafePath } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  kvList,
  kvTerm,
  kvValue,
  panel,
  panelBody,
} from "@/ui/control-styles";
import { ReadFailure } from "@/ui/read-failure";
import { SteeringRepoProvisioning } from "./provisioning";
import { SteeringRepositoryLink } from "./repository-link";
import type { RepoHealth, SteeringRepoRead } from "./types";

// The page shows one card, so a fixed id is unique. The card renders on the
// server, where the app uses no useId.
const HEADING_ID = "steering-repo-heading";

const HEALTH_TONE: Record<RepoHealth, BadgeTone> = {
  healthy: "allowed",
  drifted: "denied",
  disconnected: "failed",
  diverged: "failed",
};

export function SteeringRepoCard({
  org,
  ws,
  read,
  canAct,
  returnTo,
}: {
  org: string;
  ws: string;
  read: SteeringRepoRead;
  /** An owner or admin: Retry is theirs. */
  canAct: boolean;
  returnTo: SafePath;
}) {
  const t = useTranslations("repositories.steeringRepo");
  return (
    <section
      aria-labelledby={HEADING_ID}
      data-testid="steering-repo-card"
      data-kind={read.kind}
      data-health={read.kind === "ok" ? (read.view.health ?? "none") : undefined}
      className="flex flex-col gap-2"
    >
      <h2
        id={HEADING_ID}
        className="text-[15px] font-semibold text-foreground"
      >
        {t("heading")}
      </h2>
      {read.kind === "failed" ? (
        <ReadFailure read={read.failure} section={t("heading")} />
      ) : (
        <div className={`${panel} ${panelBody} flex flex-col gap-3`}>
          <dl className={kvList}>
            <dt className={kvTerm}>{t("card.repository")}</dt>
            <dd className={kvValue}>
              {read.view.repository === null ? (
                <span className="text-muted-foreground">
                  {t("card.notCreated")}
                </span>
              ) : (
                <SteeringRepositoryLink
                  provider={read.view.provider}
                  repository={read.view.repository}
                  testId="steering-repo-link"
                />
              )}
            </dd>
            <dt className={kvTerm}>{t("card.version")}</dt>
            <dd className={kvValue} data-testid="steering-repo-version">
              {read.view.publishedVersion === null
                ? t("card.notPublished")
                : t("card.versionNumber", {
                    version: String(read.view.publishedVersion),
                  })}
            </dd>
            {read.view.status === "ready" ? (
              <>
                <dt className={kvTerm}>{t("card.health")}</dt>
                <dd
                  className={`${kvValue} flex flex-col items-start gap-1`}
                  data-testid="steering-repo-health"
                >
                  {read.view.health === null ? (
                    <Badge tone="quiet">{t("health.unknown")}</Badge>
                  ) : (
                    <Badge tone={HEALTH_TONE[read.view.health]}>
                      {t(`health.${read.view.health}`)}
                    </Badge>
                  )}
                  <span className="text-muted-foreground">
                    {t(`healthNote.${read.view.health ?? "unknown"}`)}
                  </span>
                </dd>
              </>
            ) : null}
          </dl>
          {read.view.status === "ready" ? null : (
            <SteeringRepoProvisioning
              org={org}
              ws={ws}
              view={read.view}
              canAct={canAct}
              returnTo={returnTo}
            />
          )}
        </div>
      )}
    </section>
  );
}
