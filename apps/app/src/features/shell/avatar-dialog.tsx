"use client";
// The person's own avatar: the shared editor (@/ui/avatar-editor) opened from
// the Account dialog's Profile tab in place of it, returning to it on save or
// cancel.
//
// Save writes through `update_profile` (account-actions.ts) with the avatar
// alone, so a display name saved since the dialog opened is not reverted. The
// pending save and the value it settled on live in `accountOperations`, which
// outlives the dialog: a person who closes the editor mid-save and reopens it
// cannot send a second write, and the reopened draft reads what landed.
import {
  AvatarEditorDialog,
  type AvatarSaveResult,
  avatarSaveResult,
} from "@/ui/avatar-editor";
import { useNavigate } from "@/ui/navigation";
import { updateProfile } from "./account-actions";
import {
  accountOperations,
  useAccountAvatar,
  useAccountOperation,
} from "./account-operations";
import { initials as initialsOf } from "./format";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";

export function AvatarDialog({ data }: { data: ShellData }) {
  const navigate = useNavigate();
  const { avatarOpen, setAvatarOpen } = useShellState();
  const { viewer, org } = data;
  const shown = viewer.name ?? viewer.email;
  const settledAvatar = useAccountAvatar(viewer.id);
  const currentAvatar =
    settledAvatar &&
    (viewer.avatarUrl === settledAvatar.previous ||
      viewer.avatarUrl === settledAvatar.value)
      ? settledAvatar.value
      : viewer.avatarUrl;
  const gate = useAccountOperation(viewer.id, "avatar");

  async function save(avatarUrl: string): Promise<AvatarSaveResult> {
    const result = await updateProfile(org.slug, { avatarUrl });
    if (!result.ok) return avatarSaveResult(result);
    accountOperations.setAvatar(
      viewer.id,
      result.value.avatarUrl ?? "",
      viewer.avatarUrl,
    );
    navigate.refresh();
    return { ok: true };
  }

  return (
    <AvatarEditorDialog
      subject="user"
      open={avatarOpen}
      onOpenChange={setAvatarOpen}
      name={shown}
      subtitle={viewer.email}
      value={currentAvatar}
      letters={initialsOf(shown)}
      removable={Boolean(viewer.avatarUrl)}
      save={save}
      onSaved={() => {
        setAvatarOpen(false);
      }}
      gate={gate}
    />
  );
}
