// Re-authorize: the way back when Oxagen lost its grant on the host. On GitHub
// the API route signs the state and sends the person to the Oxagen app's
// authorization page, and GitHub returns them through the app's callback to
// `returnTo`. On GitLab the group token is pasted again on onboarding's
// connect step.
import { useTranslations } from "next-intl";
import { useId } from "react";
import { routes, type SafePath } from "@/shared/safe-path";
import { buttonSecondary, panel, panelBody } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { steeringGithubHref } from "./hrefs";
import type { SteeringRepoView } from "./types";

export function ReauthorizeLink({
  org,
  provider,
  returnTo,
  testId,
}: {
  org: string;
  /** Null reads as GitHub, the default host. */
  provider: SteeringRepoView["provider"];
  returnTo: SafePath;
  testId: string;
}) {
  const t = useTranslations("repositories.steeringRepo.reauthorize");
  if (provider === "gitlab")
    return (
      <SafeLink
        to={routes.welcomeConnect(org)}
        data-testid={testId}
        data-provider="gitlab"
        className={buttonSecondary}
      >
        {t("action")}
      </SafeLink>
    );
  return (
    <a
      // eslint-disable-next-line no-restricted-syntax -- a same-origin API route that redirects to GitHub. SafeLink would prefetch it through next/link, and ui/navigation has no plain-anchor link for a SafePath (#4518)
      href={steeringGithubHref(org, { mode: "authorize" }, returnTo)}
      data-testid={testId}
      data-provider="github"
      className={buttonSecondary}
    >
      {t("action")}
    </a>
  );
}

/**
 * The notice a step shows when its error asks an owner to authorize Oxagen
 * again. Everyone reads why provisioning stopped. Only an owner or admin gets
 * the link, because the API refuses anyone else.
 */
export function ReauthorizeNotice({
  org,
  provider,
  returnTo,
  canAct,
}: {
  org: string;
  provider: SteeringRepoView["provider"];
  returnTo: SafePath;
  /** An owner or admin: the authorization is theirs. */
  canAct: boolean;
}) {
  const t = useTranslations("repositories.steeringRepo.reauthorize");
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="steering-repo-reauthorize"
      className={`${panel} ${panelBody} flex flex-col items-start gap-2`}
    >
      <h3
        id={headingId}
        className="text-[13.5px] font-semibold text-foreground"
      >
        {t("heading")}
      </h3>
      <p className="text-[13px] text-muted-foreground">{t("body")}</p>
      {canAct ? (
        <ReauthorizeLink
          org={org}
          provider={provider}
          returnTo={returnTo}
          testId="steering-repo-reauthorize-link"
        />
      ) : null}
    </section>
  );
}
