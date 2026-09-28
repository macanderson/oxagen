"use client";
// The Workspaces section's three writes (#2964): create a workspace, rename
// one, and archive one. Creating a workspace in the app is what this lane adds
// to rev1: between the organization's first workspace, which `create_org`
// makes, and this form, a second one was made through the API, MCP or CLI.
// Each write reloads the page it changed.
//
// The create form asks for a name only. `create_workspace` makes the
// workspace's private steering repo itself (lane S1, #4450), so the person
// picks no repository, and the slug is made from the name (`slugFromName`).
// The dialog stays open once the write answers, to say where the steering repo
// stands and to link to the Repositories page, which shows each provisioning
// step and a retry. The edit form shows the main repository and branch
// `list_repositories` reports, read-only, because which repository is main does
// not change from here (spec §10.1 makes that an org owner's decision).
import { GOVERNANCE_MODES } from "@oxagen/oxagen/contracts/context.steering.shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Workspace, WorkspaceFacts } from "@/data/contracts/org";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes } from "@/shared/safe-path";
import { inputBase } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { PullRequestLink, SafeLink, useNavigate } from "@/ui/navigation";
import {
  archiveWorkspace,
  createWorkspace,
  editWorkspace,
  type GovernanceChanged,
  type NewWorkspaceDraft,
  type WorkspaceCreated,
} from "./actions";
import { textValue, WriteDialog } from "./dialog";
import { note, warn } from "./parts";

/** The create form's draft: the name, which is all the form asks for. */
function newDraftOf(form: FormData): NewWorkspaceDraft {
  return { name: textValue(form, "name") };
}

/**
 * The steering governance mode, as the design's `wsGov` select, whose first
 * choice is "leave unchanged".
 *
 * It defaults that way on purpose. The mode lives in a file on GitHub
 * (ADR-061), and this section runs in an org-only scope that cannot read it for
 * another workspace, so pre-selecting a mode would either need a GitHub round
 * trip per row or state a mode the page had guessed. Unchanged is the one
 * honest default, and it keeps a plain rename free of any governance call.
 *
 * The override is offered to everyone who sees this, because everyone who sees
 * this already holds it: the dialog opens for an org Owner or Admin, which is
 * inside the set `set_governance_mode` admits. It is disabled until a mode is
 * picked, so it never sits live over a form that is going to change nothing.
 */
function GovernanceField({ idPrefix }: { idPrefix: string }) {
  const t = useTranslations("organization.actions.governance");
  const [mode, setMode] = useState("");
  const option = (choice: string) =>
    choice === "solo"
      ? t("solo")
      : choice === "team"
        ? t("team")
        : t("regulated");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label
        htmlFor={`${idPrefix}-governance`}
        className="text-sm font-medium text-foreground"
      >
        {t("heading")}
      </label>
      <select
        id={`${idPrefix}-governance`}
        name="mode"
        value={mode}
        aria-describedby={`${idPrefix}-governance-about`}
        data-testid={`${idPrefix}-governance`}
        onChange={(event) => {
          setMode(event.target.value);
        }}
        className={`${inputBase} max-md:text-base`}
      >
        <option value="">{t("unchanged")}</option>
        {GOVERNANCE_MODES.map((choice) => (
          <option key={choice} value={choice}>
            {option(choice)}
          </option>
        ))}
      </select>
      <p
        id={`${idPrefix}-governance-about`}
        className="text-xs text-muted-foreground"
      >
        {t("about")}
      </p>
      <label
        data-touch-target=""
        className="flex min-h-11 items-start gap-2.5 text-sm has-[:disabled]:opacity-50"
      >
        <input
          type="checkbox"
          className="mt-1"
          name="applyImmediately"
          value="yes"
          disabled={mode === ""}
          aria-describedby={`${idPrefix}-governance-override-hint`}
        />
        <span>
          <b className="block font-medium">{t("override")}</b>
          <span
            id={`${idPrefix}-governance-override-hint`}
            className="block text-xs text-muted-foreground"
          >
            {t("overrideHint")}
          </span>
        </span>
      </label>
    </div>
  );
}

/**
 * A field the design draws whose value no contract records or takes yet:
 * shown read-only with the words "not recorded" and a hint saying why, so the
 * form never implies it set something it did not.
 */
function UnrecordedField({
  id,
  label,
  hint,
  value,
}: {
  id: string;
  label: string;
  hint: string;
  /** A value the record does carry, such as the namespace; else "not recorded". */
  value?: string;
}) {
  const t = useTranslations("organization");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        readOnly
        disabled
        value={value ?? t("notRecorded")}
        aria-describedby={`${id}-hint`}
        className={`${inputBase} max-md:text-base ${value === undefined ? "text-dim" : "font-mono"}`}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

/**
 * Production branch on the Edit form, the design's `wsBranch` select. It
 * offers the one branch `list_repositories` records for the main repository,
 * and it is disabled: `edit_workspace` takes no branch, and the binding moves
 * only by a re-approval on the Repositories page, which the hint says. A
 * select that offered main, release and production would promise a write the
 * form cannot make.
 */
function BranchSelect({ id, branch }: { id: string; branch: string | null }) {
  const t = useTranslations("organization");
  const tf = useTranslations("organization.actions.fields");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {tf("productionBranch")}
      </label>
      <select
        id={id}
        disabled
        aria-describedby={`${id}-hint`}
        data-testid="edit-workspace-branch"
        className={`${inputBase} max-md:text-base ${branch === null ? "text-dim" : "font-mono"}`}
      >
        <option>{branch ?? t("notRecorded")}</option>
      </select>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {tf("productionBranchHint")}
      </p>
    </div>
  );
}

/**
 * The workspace facts the Edit dialog lists under its fields. The agent count
 * is `list_agents`', when the tab could read inside the workspace; nothing
 * records a toolbelt limit or a default budget per workspace yet (#3933).
 */
function WorkspaceFactList({ agents }: { agents: number | null }) {
  const t = useTranslations("organization.actions.editWorkspace.facts");
  const tOrg = useTranslations("organization");
  const term = "text-muted-foreground";
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      <dt className={term}>{t("toolbelt")}</dt>
      <dd className="text-dim">{tOrg("notRecorded")}</dd>
      <dt className={term}>{t("budget")}</dt>
      <dd className="text-dim">{tOrg("notRecorded")}</dd>
      <dt className={term}>{t("agents")}</dt>
      {agents === null ? (
        <dd className="text-dim">{tOrg("notRecorded")}</dd>
      ) : (
        <dd className="tabular-nums" data-testid="edit-workspace-agents">
          {t("agentsCount", { count: agents })}
        </dd>
      )}
    </dl>
  );
}

/**
 * Whether the governance half left anything worth holding the dialog open for.
 *
 * It is a predicate rather than a null return from the panel itself, because
 * `WriteDialog` asks before it renders: a component that renders nothing is
 * still a node, and the dialog would stay open on an empty panel. A rename
 * alone, or a mode the file already declared, has nothing to say and closes as
 * every other write does.
 */
function hasGovernanceNote(governance: GovernanceChanged | null): boolean {
  if (governance === null) return false;
  if (!governance.ok) return true;
  return governance.outcome !== "unchanged";
}

/**
 * The proposal's pull request, linked only when the URL parses as one
 * (INV-13): the value arrives from GitHub through the capability, so the app
 * checks it here rather than rendering whatever came back as an href. A URL
 * that does not parse still leaves the number on screen, which is enough to
 * find the pull request by hand.
 */
function GovernancePullRequest({
  pullRequest,
}: {
  pullRequest: { number: number; htmlUrl: string };
}) {
  const t = useTranslations("organization.actions.governance");
  const href = parsePullRequestUrl(pullRequest.htmlUrl);
  const label = t("done.openPr", { number: pullRequest.number });
  if (href === null) {
    return <p className="text-muted-foreground">{label}</p>;
  }
  return (
    <PullRequestLink
      to={href}
      data-testid="edit-workspace-governance-pr"
      className="font-medium underline"
    >
      {label}
    </PullRequestLink>
  );
}

/**
 * What the governance half of the edit left to read. A proposal has to stay on
 * screen: the pull request URL is not something the person can reconstruct, and
 * until someone merges it the mode has not moved.
 */
function GovernanceResult({
  governance,
}: {
  governance: GovernanceChanged | null;
}) {
  const t = useTranslations("organization.actions.governance");
  if (governance === null) return null;
  if (!governance.ok) {
    return (
      <p className="text-sm text-error-ink">
        {t("done.refused", { reason: governance.code ?? governance.reason })}
      </p>
    );
  }
  if (governance.outcome === "unchanged") return null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {governance.outcome === "applied"
          ? t("done.applied", {
              mode: governance.mode,
              branch: governance.branch,
              repo: governance.repo,
            })
          : t("done.proposed", {
              mode: governance.mode,
              branch: governance.branch,
            })}
      </p>
      {governance.overrodeReview ? (
        <p className="text-muted-foreground">{t("done.overridden")}</p>
      ) : null}
      {governance.pullRequest === null ? null : (
        <>
          {governance.pullRequest.reused ? (
            <p className="text-muted-foreground">{t("done.reused")}</p>
          ) : null}
          <GovernancePullRequest pullRequest={governance.pullRequest} />
        </>
      )}
    </div>
  );
}

/**
 * What the create dialog shows once `create_workspace` answered: the new
 * workspace, and where its steering repo stood when the call returned. A
 * durable job makes the repository, so the usual answer is `provisioning`. The
 * Repositories page shows each step, and a retry when one stopped.
 */
function WorkspaceCreatedPanel({
  org,
  created,
}: {
  org: string;
  created: WorkspaceCreated;
}) {
  const t = useTranslations("organization.actions.createWorkspace.done");
  const term = "text-muted-foreground";
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className={term}>{t("workspace")}</dt>
        <dd className="font-medium" data-testid="create-workspace-done-name">
          {created.name}
        </dd>
        <dt className={term}>{t("steeringRepo")}</dt>
        <dd data-testid="create-workspace-steering-status">
          {t(`status.${created.steeringRepo}`)}
        </dd>
      </dl>
      <SafeLink
        to={routes.repositories(org, created.slug)}
        data-testid="create-workspace-open-repositories"
        className="font-medium underline"
      >
        {t("openRepositories")}
      </SafeLink>
    </div>
  );
}

export function CreateWorkspace({
  org,
  primary = false,
}: {
  org: string;
  /** The header's and the empty state's gold action; the panel's is plain. */
  primary?: boolean;
}) {
  const t = useTranslations("organization.actions");
  const tr = useTranslations("organization.receipts");
  const tf = useTranslations("organization.actions.fields");
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("createWorkspace.open"),
        title: t("createWorkspace.title"),
        confirm: t("createWorkspace.confirm"),
        pending: t("createWorkspace.pending"),
        receipt: tr("workspaceCreated"),
      }}
      testId="create-workspace"
      primary={primary}
      submit={(form) => createWorkspace(org, newDraftOf(form))}
      done={{
        close: t("createWorkspace.done.close"),
        render: (created) => (
          <WorkspaceCreatedPanel org={org} created={created} />
        ),
      }}
      onDone={(created) => {
        // WL-62: the workspace that was just made is where the operator wants to
        // be, so closing the panel opens it by the slug the write returned.
        navigate.replace(routes.fleet(org, created.slug));
      }}
    >
      <Field
        id="create-workspace-name"
        name="name"
        label={tf("name")}
        required
      />
    </WriteDialog>
  );
}

export function EditWorkspace({
  org,
  workspace,
  facts = null,
}: {
  org: string;
  workspace: Workspace;
  /** What the tab read inside this workspace; null when it could not. */
  facts?: WorkspaceFacts | null;
}) {
  const t = useTranslations("organization.actions");
  const tr = useTranslations("organization.receipts");
  const tf = useTranslations("organization.actions.fields");
  const tg = useTranslations("organization.actions.governance");
  const navigate = useNavigate();
  const main = facts?.repositories.find((repo) => repo.role === "main");
  return (
    <WriteDialog
      copy={{
        open: t("editWorkspace.open"),
        title: t("editWorkspace.title"),
        subtitle: workspace.slug,
        confirm: t("editWorkspace.confirm"),
        pending: t("editWorkspace.pending"),
        receipt: tr("workspaceSaved", { name: workspace.name }),
      }}
      testId={`edit-workspace-${workspace.id}`}
      submit={(form) =>
        editWorkspace(org, workspace.id, {
          // The design's Edit form has no slug field: the slug the workspace
          // has is sent back, so a rename never moves its URLs.
          name: textValue(form, "name"),
          slug: workspace.slug,
          mode: textValue(form, "mode"),
          // The checkbox only reaches the form when it is ticked, and it is
          // disabled until a mode is picked, so anything else is false.
          applyImmediately: textValue(form, "applyImmediately") === "yes",
        })
      }
      done={{
        close: tg("done.close"),
        render: (edited) =>
          hasGovernanceNote(edited.governance) ? (
            <GovernanceResult governance={edited.governance} />
          ) : null,
      }}
      onDone={() => {
        navigate.replace(routes.organization(org, "workspaces"));
      }}
    >
      <Field
        id={`edit-workspace-${workspace.id}-name`}
        name="name"
        label={tf("name")}
        required
        defaultValue={workspace.name}
      />
      <UnrecordedField
        id={`edit-workspace-${workspace.id}-main`}
        label={tf("mainRepo")}
        hint={tf("mainRepoFixed")}
        {...(main === undefined ? {} : { value: main.fullName })}
      />
      <BranchSelect
        id={`edit-workspace-${workspace.id}-branch`}
        branch={main?.defaultRef ?? null}
      />
      <GovernanceField idPrefix={`edit-workspace-${workspace.id}`} />
      <UnrecordedField
        id={`edit-workspace-${workspace.id}-namespace`}
        label={tf("namespace")}
        hint={tf("namespaceHint")}
        value={workspace.namespace}
      />
      <UnrecordedField
        id={`edit-workspace-${workspace.id}-retention`}
        label={tf("retention")}
        hint={tf("retentionHint")}
      />
      <WorkspaceFactList agents={facts?.agents ?? null} />
    </WriteDialog>
  );
}

/**
 * What Archive says about the agents registered in the workspace, and whether
 * it can be sent. `archive_workspace` refuses while any live agent other than
 * the built-in one is registered (`workspace_has_agents`), so the dialog warns
 * and disables its confirm when the facts count one, as the design draws it.
 * A workspace the viewer cannot enter has no facts: the dialog says the count
 * is not readable and leaves the refusal to the handler.
 */
function ArchiveAgents({
  blockers,
}: {
  blockers: WorkspaceFacts["archiveBlockers"] | null;
}) {
  const t = useTranslations("organization.actions.archiveWorkspace");
  if (blockers === null) {
    return (
      <p data-testid="archive-workspace-agents" className={note}>
        {t("agentsUnread")}
      </p>
    );
  }
  if (blockers.count === 0) {
    return (
      <p data-testid="archive-workspace-agents" className={note}>
        {t("noAgents")}
      </p>
    );
  }
  return (
    <p role="alert" data-testid="archive-workspace-agents" className={warn}>
      {t("agents", {
        count: blockers.count,
        more: blockers.more ? "yes" : "no",
      })}
    </p>
  );
}

export function ArchiveWorkspace({
  org,
  workspace,
  facts = null,
}: {
  org: string;
  workspace: Workspace;
  /** What the tab read inside this workspace; null when it could not. */
  facts?: WorkspaceFacts | null;
}) {
  const t = useTranslations("organization.actions");
  const tr = useTranslations("organization.receipts");
  const navigate = useNavigate();
  const blockers = facts?.archiveBlockers ?? null;
  return (
    <WriteDialog
      copy={{
        open: t("archiveWorkspace.open"),
        title: t("archiveWorkspace.title"),
        subtitle: workspace.name,
        confirm: t("archiveWorkspace.confirm"),
        pending: t("archiveWorkspace.pending"),
        receipt: tr("workspaceArchived", { name: workspace.name }),
      }}
      testId={`archive-workspace-${workspace.id}`}
      danger
      blocked={blockers !== null && blockers.count > 0}
      submit={() => archiveWorkspace(org, workspace.id)}
      onDone={() => {
        navigate.replace(routes.organization(org, "workspaces"));
      }}
    >
      <p className="text-sm">
        {t.rich("archiveWorkspace.body", {
          name: workspace.name,
          b: (chunks) => <b>{chunks}</b>,
        })}
      </p>
      <ArchiveAgents blockers={blockers} />
    </WriteDialog>
  );
}
