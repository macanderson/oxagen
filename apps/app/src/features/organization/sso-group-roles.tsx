"use client";
// One identity provider's table of IdP group to organization role (ADR-142),
// on the Roles page. Rows are added and removed here and saved together:
// `set_sso_group_roles` replaces the whole table, so Save sends every row the
// editor holds and nothing else.
//
// The role select offers admin, compliance, billing, and member. It never
// offers owner: ownership is transferred by a person, never minted by an
// identity provider.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useRef, useState } from "react";
import type { SsoGroupRole, SsoMappableRole } from "@/data/contracts/org";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { cell, Table } from "@/ui/table";
import { setSsoGroupRoles } from "./sso-actions";
import { SSO_UNANSWERED, type SsoFailure, useSsoFailure } from "./sso-failure";
import { isSsoRole, SSO_ROLES } from "./sso-rules";

type Row = { key: number; group: string; role: SsoMappableRole };

/** The row index a refusal names, from a field such as `mappings.2.group`. */
function refusedRow(failure: SsoFailure | null): number | null {
  if (failure?.reason !== "invalid" || failure.field === undefined) return null;
  const match = /^mappings\.(\d+)\.group$/.exec(failure.field);
  return match ? Number(match[1]) : null;
}

export function SsoGroupRoles({
  org,
  providerId,
  providerName,
  mappings,
  canEdit,
}: {
  org: string;
  providerId: string;
  providerName: string;
  mappings: readonly SsoGroupRole[];
  /** Owners and admins edit; the handler checks the role again. */
  canEdit: boolean;
}) {
  const t = useTranslations("organization.ssoGroups");
  const failureText = useSsoFailure();
  const navigate = useNavigate();
  const nextKeyRef = useRef(mappings.length);
  const [rows, setRows] = useState<Row[]>(() =>
    mappings.map((m, key) => ({ key, group: m.group, role: m.role })),
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<SsoFailure | null>(null);
  const [saved, setSaved] = useState(false);

  const columns = [
    { label: t("columns.group") },
    { label: t("columns.role") },
    ...(canEdit ? [{ label: t("columns.actions") }] : []),
  ];

  function update(key: number, patch: Partial<Omit<Row, "key">>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setSaved(false);
  }

  function addRow() {
    const key = nextKeyRef.current;
    nextKeyRef.current += 1;
    setRows((rs) => [...rs, { key, group: "", role: "member" }]);
    setSaved(false);
  }

  function removeRow(key: number) {
    setRows((rs) => rs.filter((r) => r.key !== key));
    setFailure(null);
    setSaved(false);
  }

  async function onSave(event: SyntheticEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    setSaved(false);
    try {
      const result = await setSsoGroupRoles(
        org,
        providerId,
        rows.map(({ group, role }) => ({ group, role })),
      );
      if (result.ok) {
        setSaved(true);
        navigate.refresh();
      } else {
        setFailure(result);
      }
    } catch {
      setFailure(SSO_UNANSWERED);
    } finally {
      setPending(false);
    }
  }

  const badRow = refusedRow(failure);
  const wholeFormFailure =
    failure !== null && badRow === null ? failureText(failure) : null;
  const idBase = `sso-groups-${providerId}`;

  const table =
    rows.length === 0 ? (
      <p
        className="text-sm text-muted-foreground"
        data-testid={`${idBase}-empty`}
      >
        {t("empty")}
      </p>
    ) : (
      <Table label={t("tableLabel", { name: providerName })} columns={columns}>
        {rows.map((row, index) => {
          const n = String(index + 1);
          const error =
            badRow === index && failure !== null ? failureText(failure) : null;
          return (
            <tr key={row.key} data-mapping-row={index}>
              <td className={cell}>
                {canEdit ? (
                  <>
                    <input
                      id={`${idBase}-group-${String(row.key)}`}
                      aria-label={t("groupLabel", { row: n })}
                      aria-invalid={error === null ? undefined : true}
                      aria-describedby={
                        error === null
                          ? undefined
                          : `${idBase}-group-${String(row.key)}-error`
                      }
                      className={`${inputBase} ${mono}`}
                      spellCheck={false}
                      value={row.group}
                      onChange={(e) => {
                        update(row.key, { group: e.target.value });
                      }}
                    />
                    {error === null ? null : (
                      <p
                        id={`${idBase}-group-${String(row.key)}-error`}
                        className="mt-1 text-sm text-error-ink"
                      >
                        {error}
                      </p>
                    )}
                  </>
                ) : (
                  <span className={mono}>{row.group}</span>
                )}
              </td>
              <td className={cell}>
                {canEdit ? (
                  <select
                    aria-label={t("roleLabel", { row: n })}
                    className={inputBase}
                    value={row.role}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (isSsoRole(value)) update(row.key, { role: value });
                    }}
                  >
                    {SSO_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(`roles.${role}`)}
                      </option>
                    ))}
                  </select>
                ) : (
                  t(`roles.${row.role}`)
                )}
              </td>
              {canEdit ? (
                <td className={cell}>
                  <button
                    type="button"
                    className={buttonSecondary}
                    aria-label={t("removeLabel", { row: n })}
                    onClick={() => {
                      removeRow(row.key);
                    }}
                  >
                    {t("remove")}
                  </button>
                </td>
              ) : null}
            </tr>
          );
        })}
      </Table>
    );

  if (!canEdit) return <div data-testid={idBase}>{table}</div>;

  return (
    <form
      noValidate
      onSubmit={(e) => void onSave(e)}
      className="flex flex-col gap-3"
      data-testid={idBase}
    >
      {table}
      {wholeFormFailure === null ? null : (
        <FormAlert testId={`${idBase}-failure`}>{wholeFormFailure}</FormAlert>
      )}
      {saved ? (
        <p role="status" className="text-sm" data-testid={`${idBase}-saved`}>
          {t("saved")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button type="button" className={buttonSecondary} onClick={addRow}>
          {t("add")}
        </button>
        <SubmitButton
          pending={pending}
          label={t("save")}
          pendingLabel={t("saving")}
          fullWidth={false}
          secondary
        />
      </div>
    </form>
  );
}
