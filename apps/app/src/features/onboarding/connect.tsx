// Connect a code host, onboarding's second step (#4518), at
// /welcome/{org}/new-workspace/connect. The organization exists and has no
// workspace yet (the form sent `create_org` `workspace: null`, #4582), so the
// step connects the host its steering repos live on before the first
// workspace creates one.
//
// **GitHub has one app.** Oxagen creates the organization's steering repos and
// reads and checks its code repositories, so one install covers both
// (ADR-228). The entry offers two links to the API route that signs the state
// and sends the person to GitHub (`steeringGithubHref`). Install comes first:
// GitHub's install page installs the app on an organization and authorizes the
// person in one pass. Authorize comes second: an organization that already has
// the app gets Configure on the install page, which drops the state, so
// authorize is the way back. GitHub returns through the app's one callback to
// the route's `return_to`, with `?steering=connected` or
// `?steering=error&code=`. Both links return to the first workspace, the step
// that uses the connection, and its result line reads the query.
//
// **GitLab has one form**: a group's path and a group access token.
//
// **Who may.** Connecting a host admits an org Owner or Admin in its handler
// (INV-29). The page checks the same role first (./roles), so a member sees
// the gate's denied state instead of links that would all be refused.
import "server-only";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  steeringGithubHref,
  steeringGitlabPath,
} from "@/features/steering-repo";
import { getAuthUser } from "@/server/session";
import type { OrgCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { mayOnboard, signedInToOrg } from "./roles";
import { GateFooter, GateHeader, GateShell } from "./ui/gate-shell";
import { GateDenied } from "./ui/gate-states";
import { GitlabConnect } from "./ui/gitlab-connect";
import { type SteeringResult, SteeringResultLine } from "./ui/steering-result";

function ConnectStep({
  org,
  result,
}: {
  org: string;
  result: SteeringResult | null;
}) {
  const t = useTranslations("onboarding.welcome.connect");
  const firstWorkspace = routes.welcomeFirstWorkspace(org);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <GateHeader eyebrow={t("eyebrow")} title={t("title")} lead={t("lead")} />
      <SteeringResultLine result={result} />
      <section
        aria-labelledby="ob-connect-github"
        data-testid="connect-github"
        className={panel}
      >
        <div className={panelHeader}>
          <h2 id="ob-connect-github" className={panelTitle}>
            {t("github.heading")}
          </h2>
        </div>
        <div
          data-testid="connect-github-app"
          className={`${panelBody} flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center`}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 className="text-[13.5px] font-semibold text-foreground">
              {t("github.name")}
            </h3>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t("github.body")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              // eslint-disable-next-line no-restricted-syntax -- a same-origin API route that redirects to GitHub. SafeLink would prefetch it through next/link, and ui/navigation has no plain-anchor link for a SafePath (#4518)
              href={steeringGithubHref(
                org,
                { mode: "install" },
                firstWorkspace,
              )}
              data-testid="connect-github-install"
              className={buttonSecondary}
            >
              {t("github.install")}
            </a>
            <a
              // eslint-disable-next-line no-restricted-syntax -- a same-origin API route that redirects to GitHub. SafeLink would prefetch it through next/link, and ui/navigation has no plain-anchor link for a SafePath (#4518)
              href={steeringGithubHref(
                org,
                { mode: "authorize" },
                firstWorkspace,
              )}
              data-testid="connect-github-authorize"
              className={buttonSecondary}
            >
              {t("github.authorize")}
            </a>
          </div>
        </div>
      </section>
      <section
        aria-labelledby="ob-connect-gitlab"
        data-testid="connect-gitlab"
        className={panel}
      >
        <div className={panelHeader}>
          <h2 id="ob-connect-gitlab" className={panelTitle}>
            {t("gitlab.heading")}
          </h2>
        </div>
        <div className={panelBody}>
          <GitlabConnect
            path={steeringGitlabPath(org)}
            next={firstWorkspace}
          />
        </div>
      </section>
      <GateFooter
        start={null}
        end={
          <SafeLink
            to={firstWorkspace}
            data-testid="connect-continue"
            className={buttonPrimary}
          >
            {t("continue")}
          </SafeLink>
        }
      />
    </div>
  );
}

export async function WelcomeConnect({
  ctx,
  result,
}: {
  ctx: OrgCtx;
  /** The GitHub install's outcome from the query, or null when it names none. */
  result: SteeringResult | null;
}) {
  const org = ctx.orgSlug;
  const user = await getAuthUser();
  const email = user?.email ?? null;
  const shell = (body: ReactNode) => (
    <GateShell
      step="connect"
      email={email}
      cancel={routes.root()}
      back={{ organization: routes.newOrganization() }}
    >
      {body}
    </GateShell>
  );
  if (!mayOnboard(ctx))
    return shell(
      <GateDenied
        org={ctx.orgName}
        permission={`connection.create on ${org}`}
        signedIn={signedInToOrg(ctx, user?.name ?? null, email)}
        back={routes.root()}
      />,
    );
  return shell(<ConnectStep org={org} result={result} />);
}
