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
import { useTranslations } from "next-intl";
import type { Workspace } from "@/data/contracts/org";
import { routes } from "@/shared/safe-path";
import { Field } from "@/ui/field";
import { useNavigate } from "@/ui/navigation";
import {
  archiveWorkspace,
  createWorkspace,
  type NewWorkspaceDraft,
  renameWorkspace,
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

export function CreateWorkspace({ org }: { org: string }) {
  const t = useTranslations("organization.actions");
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("createWorkspace.open"),
        title: t("createWorkspace.title"),
        confirm: t("createWorkspace.confirm"),
        pending: t("createWorkspace.pending"),
      }}
      testId="create-workspace"
      submit={(form) => createWorkspace(org, newDraftOf(form))}
      onDone={(created) => {
        // WL-62: the workspace that was just made is where the operator wants to
        // be, so the write's slug is what the navigation uses — the org page
        // would leave `createWorkspace`'s answer with no reader.
        navigate.replace(routes.fleet(org, created.slug));
      }}
    >
      <Fields idPrefix="create-workspace" mainRepo />
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
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("editWorkspace.open"),
        title: t("editWorkspace.title", { name: workspace.name }),
        confirm: t("editWorkspace.confirm"),
        pending: t("editWorkspace.pending"),
      }}
      testId={`edit-workspace-${workspace.id}`}
      submit={(form) => renameWorkspace(org, workspace.id, draftOf(form))}
      onDone={() => {
        navigate.replace(routes.people(org));
      }}
    >
      <Fields
        idPrefix={`edit-workspace-${workspace.id}`}
        workspace={workspace}
      />
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
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("archiveWorkspace.open"),
        title: t("archiveWorkspace.title", { name: workspace.name }),
        confirm: t("archiveWorkspace.confirm"),
        pending: t("archiveWorkspace.pending"),
      }}
      testId={`archive-workspace-${workspace.id}`}
      submit={() => archiveWorkspace(org, workspace.id)}
      onDone={() => {
        navigate.replace(routes.people(org));
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t("archiveWorkspace.body")}
      </p>
    </WriteDialog>
  );
}
