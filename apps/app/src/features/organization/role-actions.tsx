"use client";
// The role editor's three writes (#2964, ADR-063): create a custom role over
// the permission catalogue, replace an existing one's permissions, and delete
// one nobody holds. Built-in roles carry no controls: the handler refuses them
// and the page does not offer the button. Each write reloads the Roles page it
// changed.
import { useTranslations } from "next-intl";
import type { Permission, Role } from "@/data/contracts/org";
import { routes } from "@/shared/safe-path";
import { inputBase } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";
import {
  createRole,
  deleteRole,
  setRolePermissions,
  type RoleDraft,
} from "./actions";
import { textValue, textValues, WriteDialog } from "./dialog";

const fieldLabel = "text-sm font-medium text-foreground";
const hint = "text-xs text-muted-foreground";

function PermissionPicker({
  catalog,
  held,
}: {
  catalog: readonly Permission[];
  /** The permissions ticked when the dialog opens. */
  held: readonly string[];
}) {
  const t = useTranslations("organization.actions.fields");
  const groups = [...new Set(catalog.map((entry) => entry.group))];
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className={fieldLabel}>{t("permissions")}</legend>
      {groups.map((group) => (
        <div key={group} className="flex flex-col gap-1.5">
          <p className={hint}>{group}</p>
          {catalog
            .filter((entry) => entry.group === group)
            .map((entry) => (
              <label
                key={entry.permission}
                className="flex items-start gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  name="permissions"
                  value={entry.permission}
                  defaultChecked={held.includes(entry.permission)}
                  className="mt-1 size-4"
                />
                <span>
                  <span className="font-medium">{entry.permission}</span>{" "}
                  <span className="text-muted-foreground">
                    {entry.description}
                  </span>
                </span>
              </label>
            ))}
        </div>
      ))}
    </fieldset>
  );
}

function draftOf(form: FormData): RoleDraft {
  return {
    name: textValue(form, "name"),
    description: textValue(form, "description"),
    scope: textValue(form, "scope"),
    permissions: textValues(form, "permissions"),
  };
}

export function CreateRole({
  org,
  catalog,
}: {
  org: string;
  catalog: readonly Permission[];
}) {
  const t = useTranslations("organization.actions");
  const tField = useTranslations("organization.actions.fields");
  const tScope = useTranslations("organization.roleCatalog.scope");
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("createRole.open"),
        title: t("createRole.title"),
        confirm: t("createRole.confirm"),
        pending: t("createRole.pending"),
      }}
      testId="create-role"
      submit={(form) => createRole(org, draftOf(form))}
      onDone={() => {
        navigate.replace(routes.roles(org));
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{tField("name")}</span>
        <input name="name" required className={inputBase} />
        <span className={hint}>{tField("roleNameHint")}</span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{tField("description")}</span>
        <input name="description" className={inputBase} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{tField("scope")}</span>
        <select name="scope" defaultValue="org" className={inputBase}>
          <option value="org">{tScope("org")}</option>
          <option value="workspace">{tScope("workspace")}</option>
        </select>
      </label>
      <PermissionPicker catalog={catalog} held={[]} />
    </WriteDialog>
  );
}

export function EditRole({
  org,
  role,
  catalog,
}: {
  org: string;
  role: Role;
  catalog: readonly Permission[];
}) {
  const t = useTranslations("organization.actions");
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("editRole.open"),
        title: t("editRole.title", { name: role.name }),
        confirm: t("editRole.confirm"),
        pending: t("editRole.pending"),
      }}
      testId={`edit-role-${role.id}`}
      submit={(form) =>
        setRolePermissions(org, role.id, textValues(form, "permissions"))
      }
      onDone={() => {
        navigate.replace(routes.roles(org));
      }}
    >
      <PermissionPicker catalog={catalog} held={role.permissions} />
    </WriteDialog>
  );
}

export function DeleteRole({ org, role }: { org: string; role: Role }) {
  const t = useTranslations("organization.actions");
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("deleteRole.open"),
        title: t("deleteRole.title", { name: role.name }),
        confirm: t("deleteRole.confirm"),
        pending: t("deleteRole.pending"),
      }}
      testId={`delete-role-${role.id}`}
      submit={() => deleteRole(org, role.id)}
      onDone={() => {
        navigate.replace(routes.roles(org));
      }}
    >
      <p className="text-sm text-muted-foreground">{t("deleteRole.body")}</p>
    </WriteDialog>
  );
}
