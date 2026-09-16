"use client";
// The Workspaces section's three writes (#2964): create a workspace, rename
// and re-slug one, and archive one. Creating a workspace in the app is what
// this lane adds to rev1: between the organization's first workspace, which
// `create_org` makes, and this form, a second one was made through the API,
// MCP or CLI. Each write reloads the page it changed.
import { useTranslations } from "next-intl";
import type { Workspace } from "@/data/contracts/org";
import { routes } from "@/shared/safe-path";
import { Field } from "@/ui/field";
import { useNavigate } from "@/ui/navigation";
import {
  archiveWorkspace,
  createWorkspace,
  renameWorkspace,
  type WorkspaceDraft,
} from "./actions";
import { textValue, WriteDialog } from "./dialog";

function draftOf(form: FormData): WorkspaceDraft {
  return { name: textValue(form, "name"), slug: textValue(form, "slug") };
}

/**
 * The name and slug a workspace write takes. Each field is a `Field`, so the
 * slug's hint reaches assistive technology through `aria-describedby` rather
 * than folding into the input's accessible name, and `idPrefix` keeps the two
 * dialogs' ids apart when both are mounted.
 */
function Fields({
  idPrefix,
  workspace,
}: {
  idPrefix: string;
  workspace?: Workspace;
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
      submit={(form) => createWorkspace(org, draftOf(form))}
      onDone={() => {
        navigate.replace(routes.people(org));
      }}
    >
      <Fields idPrefix="create-workspace" />
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
