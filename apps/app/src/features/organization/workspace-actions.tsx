"use client";
// The Workspaces section's three writes (#2964): create a workspace, rename
// and re-slug one, and archive one. Creating a workspace in the app is what
// this lane adds to rev1: between the organization's first workspace, which
// `create_org` makes, and this form, a second one was made through the API,
// MCP or CLI. Each write reloads the page it changed.
import { useTranslations } from "next-intl";
import type { Workspace } from "@/data/contracts/org";
import { routes } from "@/shared/safe-path";
import { inputBase } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";
import {
  archiveWorkspace,
  createWorkspace,
  renameWorkspace,
  type WorkspaceDraft,
} from "./actions";
import { textValue, WriteDialog } from "./dialog";

const fieldLabel = "text-sm font-medium text-foreground";
const hint = "text-xs text-muted-foreground";

function draftOf(form: FormData): WorkspaceDraft {
  return { name: textValue(form, "name"), slug: textValue(form, "slug") };
}

function Fields({ workspace }: { workspace?: Workspace }) {
  const t = useTranslations("organization.actions.fields");
  return (
    <>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{t("name")}</span>
        <input
          name="name"
          required
          defaultValue={workspace?.name}
          className={inputBase}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{t("slug")}</span>
        <input
          name="slug"
          required
          defaultValue={workspace?.slug}
          className={inputBase}
        />
        <span className={hint}>{t("slugHint")}</span>
      </label>
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
      <Fields />
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
      <Fields workspace={workspace} />
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
