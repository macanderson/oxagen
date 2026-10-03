// Create the first workspace, onboarding's third step (#4518), at
// /welcome/{org}/new-workspace. A workspace never exists without its steering
// repo: `create_workspace` starts the repo's provisioning in the same write.
// So the step has two faces. With no workspace it asks for a name, and nothing
// else. Once one exists it shows that workspace's steering repo being
// provisioned, and Continue goes on to Wrap an agent. When the steering repo
// read fails, the step says who was denied what, or which code the control
// plane answered, and Continue still goes on.
//
// **Which workspace.** The first live workspace the viewer holds a role in,
// from `list_workspaces`. The organization form sends `create_org`
// `workspace: null` (#4582), so a new organization arrives here with no
// workspace and sees the form. One made before that change arrives with its
// Default workspace and sees its provisioning. A failed read shows the form
// under an alert: `create_workspace`
// refuses a taken name, so the form cannot make a second workspace by mistake
// without the person seeing why.
//
// **Who may.** `create_workspace` and the provisioning's Retry admit an org
// Owner or Admin in their handlers (INV-29). The page checks the same role
// first (./roles), so a member sees the gate's denied state and reads nothing.
import "server-only";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { WorkspaceList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import {
  readSteeringRepo,
  SteeringRepoProvisioning,
  type SteeringRepoRead,
} from "@/features/steering-repo";
import { getAuthUser } from "@/server/session";
import { type OrgCtx, requireViewer } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, panel } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { mayOnboard, signedInToOrg } from "./roles";
import { FirstWorkspaceForm } from "./ui/first-workspace-form";
import { GateFooter, GateHeader, GateShell } from "./ui/gate-shell";
import { GateDenied } from "./ui/gate-states";
import { type SteeringResult, SteeringResultLine } from "./ui/steering-result";

type Chosen = { slug: string; name: string };

/** The first live workspace the viewer holds a role in, or null when there is none. */
function chosenOf(read: Read<WorkspaceList>): Chosen | null {
  if (!read.ok) return null;
  const first = read.value.workspaces.find(
    (ws) => ws.archivedAt === null && ws.role !== null,
  );
  return first === undefined ? null : { slug: first.slug, name: first.name };
}

/** The code a failed read names, or null when the read answered. */
function failureOf(read: Read<WorkspaceList>): string | null {
  if (read.ok) return null;
  return read.reason === "error" ? read.code : read.reason;
}

function CreateStep({
  org,
  result,
  failed,
}: {
  org: string;
  result: SteeringResult | null;
  /** The code of a failed workspace read, or null when it answered. */
  failed: string | null;
}) {
  const t = useTranslations("onboarding.welcome.workspace");
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <GateHeader eyebrow={t("eyebrow")} title={t("title")} lead={t("lead")} />
      <SteeringResultLine result={result} />
      {failed === null ? null : (
        <FormAlert testId="first-workspace-read-failed">
          {t("readFailed", { code: failed })}
        </FormAlert>
      )}
      <div className={`${panel} flex flex-col gap-4 p-4.5 sm:p-5`}>
        <FirstWorkspaceForm org={org} />
      </div>
      <GateFooter
        start={
          <SafeLink to={routes.welcomeConnect(org)} className={buttonSecondary}>
            {t("back")}
          </SafeLink>
        }
      />
    </div>
  );
}

function ProvisionStep({
  org,
  workspace,
  result,
  steering,
}: {
  org: string;
  workspace: Chosen;
  result: SteeringResult | null;
  steering: SteeringRepoRead;
}) {
  const t = useTranslations("onboarding.welcome.workspace");
  const steeringRepo = useTranslations("repositories.steeringRepo");
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <GateHeader
        eyebrow={t("eyebrow")}
        title={t("titleExisting")}
        lead={t("leadExisting", { workspace: workspace.name })}
      />
      <SteeringResultLine result={result} />
      {steering.kind === "ok" ? (
        <SteeringRepoProvisioning
          org={org}
          ws={workspace.slug}
          view={steering.view}
          canAct
          returnTo={routes.welcomeFirstWorkspace(org)}
        />
      ) : (
        <ReadFailure
          read={steering.failure}
          section={steeringRepo("heading")}
        />
      )}
      <GateFooter
        start={
          <SafeLink to={routes.welcomeConnect(org)} className={buttonSecondary}>
            {t("back")}
          </SafeLink>
        }
        end={
          <SafeLink
            to={routes.welcome(org, workspace.slug, "wrap")}
            data-testid="workspace-continue"
            className={buttonPrimary}
          >
            {t("continue")}
          </SafeLink>
        }
      />
    </div>
  );
}

export async function WelcomeFirstWorkspace({
  ctx,
  source,
  result,
}: {
  ctx: OrgCtx;
  source: DataSource;
  /** The GitHub install's outcome from the query, or null when it names none. */
  result: SteeringResult | null;
}) {
  const org = ctx.orgSlug;
  const user = await getAuthUser();
  const email = user?.email ?? null;
  const shell = (body: ReactNode) => (
    <GateShell
      step="workspace"
      email={email}
      cancel={routes.root()}
      back={{
        organization: routes.newOrganization(),
        connect: routes.welcomeConnect(org),
      }}
    >
      {body}
    </GateShell>
  );
  if (!mayOnboard(ctx))
    return shell(
      <GateDenied
        org={ctx.orgName}
        permission={`workspace.create on ${org}`}
        signedIn={signedInToOrg(ctx, user?.name ?? null, email)}
        back={routes.root()}
      />,
    );
  const read = await source.org.workspaces(ctx);
  const workspace = chosenOf(read);
  if (workspace === null)
    return shell(
      <CreateStep org={org} result={result} failed={failureOf(read)} />,
    );
  const wsCtx = await requireViewer(org, workspace.slug);
  const steering = await readSteeringRepo(source, wsCtx);
  return shell(
    <ProvisionStep
      org={org}
      workspace={workspace}
      result={result}
      steering={steering}
    />,
  );
}
