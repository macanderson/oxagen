"use client";
// The Workspaces section's three writes (#2964): create a workspace, rename
// and re-slug one, and archive one. Creating a workspace in the app is what
// this lane adds to rev1: between the organization's first workspace, which
// `create_org` makes, and this form, a second one was made through the API,
// MCP or CLI. Each write reloads the page it changed.
//
// A workspace is created with its main repository (MC spec §10.1, §17 M0: a
// workspace cannot be created without one), so the create form asks for it as
// one `owner/name` field beside the name and the slug. The person names only
// the repository, never an installation: `create_workspace` finds the GitHub
// App installation from the owner through the org's GitHub authorization, and
// refuses with a reason `action-failure.ts` has a sentence for when it cannot.
// The edit form keeps its two fields, because which repository is main does
// not change from here (spec §10.1 makes that an org owner's decision).
import { GOVERNANCE_MODES } from "@oxagen/oxagen/contracts/context.steering.shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Workspace } from "@/data/contracts/org";
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
  type WorkspaceDraft,
} from "./actions";
import { textValue, WriteDialog } from "./dialog";

function draftOf(form: FormData): WorkspaceDraft {
  return { name: textValue(form, "name"), slug: textValue(form, "slug") };
}

/** The create form's draft: the two fields above and the main repository as typed. */
function newDraftOf(form: FormData): NewWorkspaceDraft {
  return { ...draftOf(form), mainRepo: textValue(form, "mainRepo") };
}

/**
 * The name and slug a workspace write takes, and for a create the main
 * repository too. Each field is a `Field`, so a hint reaches assistive
 * technology through `aria-describedby` rather than folding into the input's
 * accessible name, and `idPrefix` keeps the two dialogs' ids apart when both
 * are mounted.
 */
function Fields({
  idPrefix,
  workspace,
  mainRepo = false,
}: {
  idPrefix: string;
  workspace?: Workspace;
  /** Ask for the main repository: the create form only. */
  mainRepo?: boolean;
}) {
  const t = useTranslations("organization.actions.fields");
  return (
    <>
      <Field
        id={`${idPrefix}-name`}
        name="name"
        label={t("name")}
        required
        defaultValue={workspace?.name}
      />
      <Field
        id={`${idPrefix}-slug`}
        name="slug"
        label={t("slug")}
        hint={t("slugHint")}
        required
        defaultValue={workspace?.slug}
      />
      {mainRepo ? (
        <Field
          id={`${idPrefix}-main-repo`}
          name="mainRepo"
          label={t("mainRepo")}
          hint={t("mainRepoHint")}
          required
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono"
        />
      ) : null}
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
  const meaning = (choice: string) =>
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
            {`${choice}: ${meaning(choice)}`}
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

/** The workspace facts the Edit dialog lists under its fields. */
function WorkspaceFacts() {
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
      <dd className="text-dim">{tOrg("notRecorded")}</dd>
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
      onDone={(created) => {
        // WL-62: the workspace that was just made is where the operator wants to
        // be, so the write's slug is what the navigation uses — the org page
        // would leave `createWorkspace`'s answer with no reader.
        navigate.replace(routes.fleet(org, created.slug));
      }}
    >
      <Fields idPrefix="create-workspace" mainRepo />
      {/* The design asks for the namespace here. create_workspace derives it
          from the slug (workspace-bootstrap.ts, deriveNamespace) and takes
          none, so the field says so rather than collecting a value it drops. */}
      <UnrecordedField
        id="create-workspace-namespace"
        label={tf("namespace")}
        hint={tf("namespaceCreateHint")}
      />
      <UnrecordedField
        id="create-workspace-branch"
        label={tf("productionBranch")}
        hint={tf("productionBranchCreateHint")}
      />
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
}: {
  org: string;
  workspace: Workspace;
}) {
  const t = useTranslations("organization.actions");
  const tr = useTranslations("organization.receipts");
  const tf = useTranslations("organization.actions.fields");
  const tg = useTranslations("organization.actions.governance");
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("editWorkspace.open"),
        title: t("editWorkspace.title", { name: workspace.name }),
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
      />
      <UnrecordedField
        id={`edit-workspace-${workspace.id}-branch`}
        label={tf("productionBranch")}
        hint={tf("productionBranchHint")}
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
      <WorkspaceFacts />
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
        title: t("archiveWorkspace.title", { name: workspace.name }),
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
