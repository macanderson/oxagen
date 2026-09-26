"use client";
// Edit avatar for the two records the Organization page owns: the
// organization itself, from the page header, and each live workspace, from
// its row on the Workspaces tab. Both open the one avatar editor
// (@/ui/avatar-editor) that the Account dialog opens for a person. Only the
// subject and the write differ. The page reaches an Owner or an Admin alone (`frame.tsx`), and both
// writes admit exactly those roles, so neither control is offered to anyone
// the handler would refuse.
//
// A save reloads the page, so the stored value the next editor opens on is the
// one the server now holds, read back through `list_workspaces`.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Workspace } from "@/data/contracts/org";
import {
  AvatarEditorDialog,
  type AvatarSubject,
  avatarSaveResult,
} from "@/ui/avatar-editor";
import { buttonSecondary } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";
import { setOrgAvatar, setWorkspaceAvatar } from "./actions";

function EditAvatar({
  subject,
  name,
  subtitle,
  value,
  write,
  testId,
}: {
  subject: AvatarSubject;
  name: string;
  subtitle: string;
  value: string | null;
  write: (value: string) => ReturnType<typeof setOrgAvatar>;
  testId: string;
}) {
  const t = useTranslations("organization.avatar");
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <AvatarEditorDialog
        subject={subject}
        open={open}
        onOpenChange={setOpen}
        name={name}
        subtitle={subtitle}
        value={value}
        save={async (next) => {
          const result = await write(next);
          if (result.ok) navigate.refresh();
          return avatarSaveResult(result);
        }}
        onSaved={() => {
          setOpen(false);
        }}
        testId={`${testId}-dialog`}
      />
    </>
  );
}

/** The Organization header's Edit avatar: `update_org_settings`. */
export function EditOrganizationAvatar({
  org,
  name,
  value,
}: {
  org: string;
  name: string;
  /** The stored avatar, from `list_workspaces`' organization block. */
  value: string | null;
}) {
  return (
    <EditAvatar
      subject="organization"
      name={name}
      subtitle={org}
      value={value}
      write={(next) => setOrgAvatar(org, next)}
      testId="edit-org-avatar"
    />
  );
}

/** A live workspace row's Edit avatar: `update_workspace_settings`. */
export function EditWorkspaceAvatar({
  org,
  workspace,
}: {
  org: string;
  workspace: Workspace;
}) {
  return (
    <EditAvatar
      subject="workspace"
      name={workspace.name}
      subtitle={workspace.slug}
      value={workspace.avatarUrl}
      write={(next) => setWorkspaceAvatar(org, workspace.id, next)}
      testId={`edit-workspace-avatar-${workspace.id}`}
    />
  );
}
