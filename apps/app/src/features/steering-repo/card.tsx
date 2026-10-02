// The steering repo on the repositories page, under the page header: the
// repository, its published version, and its health once the repo is ready.
// While it is not ready, one line says where setup stands and opens the setup
// dialog (./setup-dialog, #4875), so the steps no longer fill the page. When
// the read fails, the card says who was denied what, or which code the
// control plane answered. The async read is ./section.
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
import { SteeringRepositoryLink } from "./repository-link";
import { SteeringRepoSetup } from "./setup-dialog";
import type {
  RepoHealth,
  SteeringRepoRead,
  SteeringRepoView,
} from "./types";

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
  canChangeConnection = canAct,
  returnTo,
  setupOpen = false,
}: {
  org: string;
  ws: string;
  read: SteeringRepoRead;
  /** An org or workspace Owner or Admin: the setup's actions are theirs. */
  canAct: boolean;
  /** An org Owner or Admin: the organization's connection is theirs. */
  canChangeConnection?: boolean;
  /** Where GitHub returns the person: this page with the setup dialog open. */
  returnTo: SafePath;
  /** The address asked for the setup dialog (`?setup=steering`). */
  setupOpen?: boolean;
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
        className="text-base font-semibold text-foreground"
      >
        {t("heading")}
      </h2>
      {read.kind === "failed" ? (
        <ReadFailure read={read.failure} section={t("heading")} />
      ) : (
        <>
          {read.view.status === "ready" ? (
            <ReadySummary view={read.view} />
          ) : null}
          <SteeringRepoSetup
            org={org}
            ws={ws}
            view={read.view}
            canAct={canAct}
            canChangeConnection={canChangeConnection}
            returnTo={returnTo}
            initiallyOpen={setupOpen}
          />
        </>
      )}
    </section>
  );
}

/** The ready repository: its link, its published version, and its health. */
function ReadySummary({ view }: { view: SteeringRepoView }) {
  const t = useTranslations("repositories.steeringRepo");
  return (
    <div className={`${panel} ${panelBody}`}>
      <dl className={kvList}>
        <dt className={kvTerm}>{t("card.repository")}</dt>
        <dd className={kvValue}>
          {view.repository === null ? (
            <span className="text-muted-foreground">{t("card.notCreated")}</span>
          ) : (
            <SteeringRepositoryLink
              provider={view.provider}
              repository={view.repository}
              testId="steering-repo-link"
            />
          )}
        </dd>
        <dt className={kvTerm}>{t("card.version")}</dt>
        <dd className={kvValue} data-testid="steering-repo-version">
          {view.publishedVersion === null
            ? t("card.notPublished")
            : t("card.versionNumber", {
                version: String(view.publishedVersion),
              })}
        </dd>
        <dt className={kvTerm}>{t("card.health")}</dt>
        <dd
          className={`${kvValue} flex flex-col items-start gap-1`}
          data-testid="steering-repo-health"
        >
          {view.health === null ? (
            <Badge tone="quiet">{t("health.unknown")}</Badge>
          ) : (
            <Badge tone={HEALTH_TONE[view.health]}>
              {t(`health.${view.health}`)}
            </Badge>
          )}
          <span className="text-muted-foreground">
            {t(`healthNote.${view.health ?? "unknown"}`)}
          </span>
        </dd>
      </dl>
    </div>
  );
}
