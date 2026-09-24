"use client";
// The Workspaces section's three writes (#2964): create a workspace, rename
// and re-slug one, and archive one. Creating a workspace in the app is what
// this lane adds to rev1: between the organization's first workspace, which
// `create_org` makes, and this form, a second one was made through the API,
// MCP or CLI. Each write reloads the page it changed.
//
// A workspace is created with its main repository (MC spec §10.1, §17 M0: a
// workspace cannot be created without one), so the create form asks for it
// beside the name, as the design's `newws` does: a select of the repositories
// the organization's installations reach, and the production branch that
// `create_workspace` will record for it. The slug is made from the name
// (`slugFromName`), because the design's form has none. The person names only
// the repository, never an installation: `create_workspace` finds the GitHub
// App installation from the owner through the org's GitHub authorization, and
// refuses with a reason `action-failure.ts` has a sentence for when it cannot.
// The edit form shows the main repository and branch `list_repositories`
// reports, read-only, because which repository is main does not change from
// here (spec §10.1 makes that an org owner's decision).
import { GOVERNANCE_MODES } from "@oxagen/oxagen/contracts/context.steering.shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { Workspace, WorkspaceFacts } from "@/data/contracts/org";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes } from "@/shared/safe-path";
import { inputBase } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { PullRequestLink, useNavigate } from "@/ui/navigation";
import {
  archiveWorkspace,
  createWorkspace,
  editWorkspace,
  type GovernanceChanged,
  type NewWorkspaceDraft,
} from "./actions";
import { textValue, WriteDialog } from "./dialog";
import {
  type RepositoryChoice,
  readRepositoryChoices,
} from "./workspace-reads";

/** The create form's draft: the name, and the main repository as chosen or typed. */
function newDraftOf(form: FormData): NewWorkspaceDraft {
  return {
    name: textValue(form, "name"),
    mainRepo: textValue(form, "mainRepo"),
  };
}

/** What the create dialog knows of the repositories a new workspace can take. */
type Choices =
  | { state: "loading" }
  | { state: "ready"; repositories: readonly RepositoryChoice[] }
  | { state: "typed" };

/**
 * Main repository and Production branch on the create form (mockup `newws`):
 * a select of the repositories the organization's GitHub App installations
 * reach, and the branch `create_workspace` will record for the one chosen,
 * which is GitHub's default. The list is read when the dialog opens
 * (`readRepositoryChoices`), because it is a live GitHub call. When nothing
 * can be read (no workspace to read through, an installation that refuses),
 * the field falls back to a typed `owner/name`, which the handler resolves the
 * same way.
 */
function RepositoryFields({
  org,
  enterable,
}: {
  org: string;
  enterable: readonly string[];
}) {
  const t = useTranslations("organization.actions.fields");
  const [choices, setChoices] = useState<Choices>(
    enterable.length === 0 ? { state: "typed" } : { state: "loading" },
  );
  const [chosen, setChosen] = useState("");
  // The slugs as one string, so a parent re-render that hands in an equal
  // list does not read GitHub again.
  const key = enterable.join("\n");
  useEffect(() => {
    const slugs = key === "" ? [] : key.split("\n");
    if (slugs.length === 0) return;
    let live = true;
    void readRepositoryChoices(org, slugs).then(
      (read) => {
        if (!live) return;
        setChoices(
          read.ok && read.value.length > 0
            ? { state: "ready", repositories: read.value }
            : { state: "typed" },
        );
      },
      () => {
        if (live) setChoices({ state: "typed" });
      },
    );
    return () => {
      live = false;
    };
  }, [org, key]);

  if (choices.state === "typed") {
    return (
      <>
        <Field
          id="create-workspace-main-repo"
          name="mainRepo"
          label={t("mainRepo")}
          hint={t("mainRepoHint")}
          required
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono"
        />
        <UnrecordedField
          id="create-workspace-branch"
          label={t("productionBranch")}
          hint={t("productionBranchCreateHint")}
        />
      </>
    );
  }
  const repositories = choices.state === "ready" ? choices.repositories : [];
  const branch = repositories.find(
    (repo) => repo.fullName === chosen,
  )?.defaultBranch;
  return (
    <>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label
          htmlFor="create-workspace-main-repo"
          className="text-sm font-medium text-foreground"
        >
          {t("mainRepo")}
        </label>
        <select
          id="create-workspace-main-repo"
          name="mainRepo"
          required
          value={chosen}
          aria-busy={choices.state === "loading" || undefined}
          aria-describedby="create-workspace-main-repo-hint"
          data-testid="create-workspace-main-repo"
          onChange={(event) => {
            setChosen(event.currentTarget.value);
          }}
          className={`${inputBase} max-md:text-base font-mono`}
        >
          <option value="">{t("mainRepoChoose")}</option>
          {repositories.map((repo) => (
            <option key={repo.fullName} value={repo.fullName}>
              {repo.fullName}
            </option>
          ))}
        </select>
        <p
          id="create-workspace-main-repo-hint"
          className="text-xs text-muted-foreground"
        >
          {t("mainRepoSelectHint")}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label
          htmlFor="create-workspace-branch"
          className="text-sm font-medium text-foreground"
        >
          {t("productionBranch")}
        </label>
        {/* One option: create_workspace takes no branch and records GitHub's
            default, so the select offers what will be recorded and no more. */}
        <select
          id="create-workspace-branch"
          disabled={branch === undefined}
          aria-describedby="create-workspace-branch-hint"
          data-testid="create-workspace-branch"
          className={`${inputBase} max-md:text-base font-mono`}
        >
          <option>
            {branch === undefined
              ? t("branchPick")
              : t("branchDefault", { branch })}
          </option>
        </select>
        <p
          id="create-workspace-branch-hint"
          className="text-xs text-muted-foreground"
        >
          {t("productionBranchCreateHint")}
        </p>
      </div>
    </>
  );
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
 *
 * `disabled` draws the same select on the create form, where
 * `create_workspace` takes no mode: the mode is set from Edit once the
 * workspace exists.
 */
function GovernanceField({
  idPrefix,
  disabled = false,
}: {
  idPrefix: string;
  disabled?: boolean;
}) {
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
        disabled={disabled}
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
        {disabled ? t("createHint") : t("about")}
      </p>
      {disabled ? null : (
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
      )}
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

export function CreateWorkspace({
  org,
  enterable = [],
  primary = false,
}: {
  org: string;
  /** The live workspaces the viewer may enter, through whose installations the repositories are read. */
  enterable?: readonly string[];
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
      onDone={(created) => {
        // WL-62: the workspace that was just made is where the operator wants to
        // be, so the write's slug is what the navigation uses — the org page
        // would leave `createWorkspace`'s answer with no reader.
        navigate.replace(routes.fleet(org, created.slug));
      }}
    >
      <Field
        id="create-workspace-name"
        name="name"
        label={tf("name")}
        required
      />
      {/* The design asks for the namespace here. create_workspace derives it
          from the slug, which the action makes from the name
          (workspace-bootstrap.ts, deriveNamespace), and takes none, so the
          field says so rather than collecting a value it drops. */}
      <UnrecordedField
        id="create-workspace-namespace"
        label={tf("namespace")}
        hint={tf("namespaceCreateHint")}
      />
      <RepositoryFields org={org} enterable={enterable} />
      <GovernanceField idPrefix="create-workspace" disabled />
      <UnrecordedField
        id="create-workspace-retention"
        label={tf("retention")}
        hint={tf("retentionHint")}
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
      <UnrecordedField
        id={`edit-workspace-${workspace.id}-branch`}
        label={tf("productionBranch")}
        hint={tf("productionBranchHint")}
        {...(main === undefined ? {} : { value: main.defaultRef })}
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

export function ArchiveWorkspace({
  org,
  workspace,
}: {
  org: string;
  workspace: Workspace;
}) {
  const t = useTranslations("organization.actions");
  const tr = useTranslations("organization.receipts");
  const navigate = useNavigate();
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
      submit={() => archiveWorkspace(org, workspace.id)}
      onDone={() => {
        navigate.replace(routes.organization(org, "workspaces"));
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t("archiveWorkspace.body")}
      </p>
    </WriteDialog>
  );
}
