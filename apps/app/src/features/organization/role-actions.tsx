"use client";
// The role editor `roleedit` and the delete dialog `roledel` (mockup
// `roleEditDlg`, `roleDelDlg`; ADR-063). One editor serves four doors:
//
//   create     Create role: every field open, nothing ticked;
//   duplicate  Duplicate: a copy named `<name>.copy` with the same
//              permissions, saved as a new custom role;
//   edit       Edit on a custom role: the permissions change, the name does
//              not (names are immutable) and the description is set at create;
//   view       View on a built-in role: read-only, with Duplicate as custom.
//
// Saving calls `create_role` or `set_role_grants`, each a governed action that
// checks the organization role in its handler and writes an audit record.
// The selected count is the number of ticked boxes, recomputed on every tick.
// A role anyone holds carries a banner saying saving changes their effective
// permission at the next call.
//
// Kind: `create_role` takes no kind. Every custom role is an agent role, held
// through `assign_agent_role` (`list_iam_roles`, `roleKindSchema`), so the
// editor shows the kind and does not offer to change it.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import type { Permission, Role } from "@/data/contracts/org";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import {
  createRole,
  deleteRole,
  type RoleDraft,
  setRolePermissions,
} from "./actions";

type EditorMode = "create" | "duplicate" | "edit" | "view";

const label = "text-[12px] font-semibold text-muted-foreground";
const hint = "text-xs text-muted-foreground";

/** What the editor holds while it is open. */
type EditorState = {
  name: string;
  description: string;
  scope: Role["scope"];
  permissions: Set<string>;
};

/** The editor's opening state for one door. */
function initial(
  mode: EditorMode,
  role: Role | undefined,
  suffix: string,
): EditorState {
  if (mode === "create" || role === undefined) {
    return {
      name: "",
      description: "",
      scope: "workspace",
      permissions: new Set<string>(),
    };
  }
  return {
    name: mode === "duplicate" ? `${role.name}${suffix}` : role.name,
    description: role.description ?? "",
    scope: role.scope,
    permissions: new Set(role.permissions),
  };
}

export function RoleEditor({
  org,
  catalog,
  mode: door,
  role,
  openLabel,
  primary = false,
}: {
  org: string;
  catalog: readonly Permission[];
  mode: EditorMode;
  /** The role the editor opens on; absent for Create role. */
  role?: Role;
  openLabel: string;
  primary?: boolean;
}) {
  const t = useTranslations("organization.roleCatalog.editor");
  const tKind = useTranslations("organization.roleCatalog.kind");
  const tScope = useTranslations("organization.roleCatalog.scope");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<EditorMode>(door);
  const [draft, setDraft] = useState(() =>
    initial(door, role, t("copySuffix")),
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const isNew = mode === "create" || mode === "duplicate";
  const readOnly = mode === "view";
  const groups = [...new Set(catalog.map((entry) => entry.group))];
  const title = isNew
    ? t("createTitle")
    : readOnly
      ? t("viewTitle")
      : t("editTitle");

  function reset(next: boolean) {
    setOpen(next);
    if (next) {
      setMode(door);
      setDraft(initial(door, role, t("copySuffix")));
      setFailure(null);
    }
  }

  function toggle(permission: string, on: boolean) {
    const permissions = new Set(draft.permissions);
    if (on) permissions.add(permission);
    else permissions.delete(permission);
    setDraft({ ...draft, permissions });
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || readOnly) return;
    setPending(true);
    setFailure(null);
    try {
      const permissions = [...draft.permissions];
      const created: RoleDraft = {
        name: draft.name,
        description: draft.description,
        scope: draft.scope,
        permissions,
      };
      const answer = isNew
        ? await createRole(org, created)
        : await setRolePermissions(org, role?.id ?? "", permissions);
      if (answer.ok) {
        setOpen(false);
        navigate.replace(routes.roles(org));
      } else {
        setFailure(failureText(answer));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const formId = `${id}-form`;
  return (
    <>
      <button
        type="button"
        className={primary ? buttonPrimary : buttonSecondary}
        onClick={() => {
          reset(true);
        }}
      >
        {openLabel}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={reset}
        title={title}
        subtitle={isNew ? undefined : role?.name}
        testId={`role-editor-${mode}${role === undefined ? "" : `-${role.id}`}`}
        wide
        closeLabel={readOnly ? t("close") : t("cancel")}
        footer={
          readOnly ? (
            <button
              type="button"
              className={buttonPrimary}
              data-touch-target=""
              onClick={() => {
                setMode("duplicate");
                setDraft(initial("duplicate", role, t("copySuffix")));
              }}
            >
              {t("duplicateAsCustom")}
            </button>
          ) : (
            <SubmitButton
              form={formId}
              pending={pending}
              fullWidth={false}
              label={isNew ? t("create") : t("save")}
              pendingLabel={isNew ? t("creating") : t("saving")}
            />
          )
        }
      >
        <form
          id={formId}
          onSubmit={(e) => void onSubmit(e)}
          className="flex flex-col gap-3.5"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={`${id}-name`} className={label}>
                {t("name")}
              </label>
              <input
                id={`${id}-name`}
                name="name"
                required
                value={draft.name}
                readOnly={!isNew}
                aria-describedby={`${id}-name-hint`}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => {
                  setDraft({ ...draft, name: event.target.value });
                }}
                className={`${inputBase} font-mono max-md:text-base`}
              />
              <p id={`${id}-name-hint`} className={hint}>
                {isNew ? t("nameNewHint") : t("nameHint")}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={`${id}-description`} className={label}>
                {t("description")}
              </label>
              <input
                id={`${id}-description`}
                name="description"
                value={draft.description}
                readOnly={!isNew}
                aria-describedby={isNew ? undefined : `${id}-description-hint`}
                onChange={(event) => {
                  setDraft({ ...draft, description: event.target.value });
                }}
                className={`${inputBase} max-md:text-base`}
              />
              {isNew ? null : (
                <p id={`${id}-description-hint`} className={hint}>
                  {t("descriptionFixed")}
                </p>
              )}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={`${id}-kind`} className={label}>
                {t("kind")}
              </label>
              <select
                id={`${id}-kind`}
                disabled
                value={isNew ? "agent" : (role?.kind ?? "agent")}
                aria-describedby={`${id}-kind-hint`}
                className={`${inputBase} max-md:text-base`}
              >
                <option value="human">{tKind("human")}</option>
                <option value="agent">{tKind("agent")}</option>
              </select>
              <p id={`${id}-kind-hint`} className={hint}>
                {t("kindHint")}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={`${id}-scope`} className={label}>
                {t("scope")}
              </label>
              <select
                id={`${id}-scope`}
                name="scope"
                disabled={!isNew}
                value={draft.scope}
                aria-describedby={`${id}-scope-hint`}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    scope: event.target.value === "org" ? "org" : "workspace",
                  });
                }}
                className={`${inputBase} max-md:text-base`}
              >
                <option value="org">{tScope("org")}</option>
                <option value="workspace">{tScope("workspace")}</option>
              </select>
              <p id={`${id}-scope-hint`} className={hint}>
                {t("scopeHint")}
              </p>
            </div>
          </div>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-1 flex w-full flex-wrap items-center justify-between gap-2">
              <span className={label}>
                {t("permissions")} ·{" "}
                <span data-testid="role-selected-count">
                  {t("selected", { count: draft.permissions.size })}
                </span>
              </span>
              {readOnly ? (
                <Badge tone="quiet" dot={false}>
                  {t("readOnly")}
                </Badge>
              ) : null}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {groups.map((group) => (
                <div key={group} className="flex flex-col gap-1">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-dim">
                    {group}
                  </p>
                  {catalog
                    .filter((entry) => entry.group === group)
                    .map((entry) => (
                      <label
                        key={entry.permission}
                        data-touch-target=""
                        className="flex min-h-8 items-start gap-2 text-[12.5px] max-md:min-h-11"
                        title={entry.description}
                      >
                        <input
                          type="checkbox"
                          name="permissions"
                          value={entry.permission}
                          checked={draft.permissions.has(entry.permission)}
                          disabled={readOnly}
                          onChange={(event) => {
                            toggle(entry.permission, event.target.checked);
                          }}
                          className="mt-0.5 size-4"
                        />
                        <span className={mono}>{entry.permission}</span>
                      </label>
                    ))}
                </div>
              ))}
            </div>
          </fieldset>
          {!isNew && role !== undefined && role.heldBy > 0 ? (
            <p
              role="note"
              data-testid="role-holders-banner"
              className="rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-[12.5px] text-foreground"
            >
              {t("holders", { count: role.heldBy })}
            </p>
          ) : null}
          <p className="border-l-2 border-gold pl-3 text-[12.5px] text-muted-foreground">
            {t("governed")}
          </p>
          {failure === null ? null : (
            <FormAlert testId="role-editor-failure">{failure}</FormAlert>
          )}
        </form>
      </SheetDialog>
    </>
  );
}

/**
 * Delete (mockup `roleDelDlg`): disabled on the row for a built-in role or one
 * anyone holds, with the reason as its title, and disabled again in the dialog
 * while anyone holds the role, because `delete_role` refuses to delete a role
 * out from under a holder.
 */
export function DeleteRole({ org, role }: { org: string; role: Role }) {
  const t = useTranslations("organization.roleCatalog");
  const tDel = useTranslations("organization.roleCatalog.del");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const reason = role.builtIn
    ? t("deleteBuiltIn")
    : role.heldBy > 0
      ? t("deleteHeld", { count: role.heldBy })
      : null;

  async function confirm() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const answer = await deleteRole(org, role.id);
      if (answer.ok) {
        setOpen(false);
        navigate.replace(routes.roles(org));
      } else {
        setFailure(failureText(answer));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`${buttonSecondary} text-error-ink`}
        disabled={reason !== null}
        title={reason ?? undefined}
        aria-label={reason === null ? undefined : `${t("delete")}: ${reason}`}
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        {t("delete")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={tDel("title")}
        subtitle={role.name}
        testId={`delete-role-${role.id}`}
        closeLabel={tDel("cancel")}
        footer={
          <button
            type="button"
            data-touch-target=""
            className={`${buttonSecondary} text-error-ink`}
            disabled={role.heldBy > 0 || pending}
            onClick={() => void confirm()}
          >
            {pending ? tDel("pending") : tDel("confirm")}
          </button>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>{tDel("body", { name: role.name })}</p>
          <p className="text-muted-foreground">
            {role.heldBy > 0
              ? tDel("held", { count: role.heldBy })
              : tDel("free")}
          </p>
          {failure === null ? null : (
            <FormAlert testId={`delete-role-${role.id}-failure`}>
              {failure}
            </FormAlert>
          )}
        </div>
      </SheetDialog>
    </>
  );
}
