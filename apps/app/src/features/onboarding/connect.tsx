// Connect a code host, onboarding's second step (#4518), at
// /welcome/{org}/new-workspace/connect. The organization exists and has no
// workspace yet, so the step connects the host its steering repos live on
// before the first workspace creates one.
//
// **GitHub has two apps.** Oxagen Steering creates the organization's steering
// repos and holds admin only on the repositories Oxagen creates. Oxagen reads
// and checks the organization's code repositories. Each install is a plain
// link to the API route that signs the state and sends the person to GitHub
// (`steeringGithubHref`). GitHub returns them to the route's `return_to`,
// with `?steering=connected` or `?steering=error&code=`, which the result
// line reads. Oxagen Steering returns to the first workspace, the step that
// uses it. Oxagen returns here, since nothing after this step needs it.
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

/** One GitHub app: its name, what it does, and its install link. */
function GithubApp({
  testId,
  name,
  body,
  action,
}: {
  testId: string;
  name: string;
  body: string;
  action: ReactNode;
}) {
  return (
    <li
      data-testid={testId}
      className="flex min-w-0 flex-col gap-3 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="text-[13.5px] font-semibold text-foreground">{name}</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>
      {action}
    </li>
  );
}

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
        <ul className={`${panelBody} flex flex-col divide-y divide-border`}>
          <GithubApp
            testId="connect-github-steering"
            name={t("github.steeringName")}
            body={t("github.steeringBody")}
            action={
              <a
                // eslint-disable-next-line no-restricted-syntax -- a same-origin API route that redirects to GitHub. SafeLink would prefetch it through next/link, and ui/navigation has no plain-anchor link for a SafePath (#4518)
                href={steeringGithubHref(
                  org,
                  { app: "steering", mode: "install" },
                  firstWorkspace,
                )}
                data-testid="connect-github-steering-install"
                className={buttonSecondary}
              >
                {t("github.steeringInstall")}
              </a>
            }
          />
          <GithubApp
            testId="connect-github-oxagen"
            name={t("github.oxagenName")}
            body={t("github.oxagenBody")}
            action={
              <a
                // eslint-disable-next-line no-restricted-syntax -- a same-origin API route that redirects to GitHub. SafeLink would prefetch it through next/link, and ui/navigation has no plain-anchor link for a SafePath (#4518)
                href={steeringGithubHref(
                  org,
                  { app: "oxagen", mode: "install" },
                  routes.welcomeConnect(org),
                )}
                data-testid="connect-github-oxagen-install"
                className={buttonSecondary}
              >
                {t("github.oxagenInstall")}
              </a>
            }
          />
        </ul>
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
