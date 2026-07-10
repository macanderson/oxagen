"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SecretKeySummary } from "@/app/[orgSlug]/[workspaceSlug]/workbench/environments/actions";
import type { LiteralEnvRow, SecretSelectionKind } from "./manifest-form-state";
import { Field, SectionCard } from "./field-controls";

export function SecretsEnvSection({
  radioGroupName,
  secretKind,
  onSecretKindChange,
  secretKeys,
  selectedKeys,
  onSelectedKeysChange,
  literalRows,
  onLiteralRowsChange,
}: {
  /** Unique `name` for the secret-kind radio pair (dialog instance may repeat). */
  radioGroupName: string;
  secretKind: SecretSelectionKind;
  onSecretKindChange: (kind: SecretSelectionKind) => void;
  secretKeys: SecretKeySummary[];
  selectedKeys: string[];
  onSelectedKeysChange: (keys: string[]) => void;
  literalRows: LiteralEnvRow[];
  onLiteralRowsChange: (rows: LiteralEnvRow[]) => void;
}) {
  return (
    <SectionCard
      title="Secrets & env"
      description="Which vault keys resolve into the sandbox, plus plain (non-secret) config injected alongside them."
    >
      <Field
        label="Secret selection"
        help='"All" resolves every live workspace vault key at run time; a selection resolves only the keys you check.'
      >
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={radioGroupName}
              checked={secretKind === "all"}
              onChange={() => onSecretKindChange("all")}
            />
            All workspace vault keys
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={radioGroupName}
              checked={secretKind === "select"}
              onChange={() => onSecretKindChange("select")}
            />
            Only selected keys
          </label>
          {secretKind === "select" && (
            <div className="flex flex-col gap-1 rounded-md border border-border/40 p-2">
              {secretKeys.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  No vault keys yet — add keys in the Secrets section above.
                </span>
              )}
              {secretKeys.map((k) => (
                <label key={k.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selectedKeys.includes(k.id)}
                    onChange={(e) =>
                      onSelectedKeysChange(
                        e.target.checked
                          ? [...selectedKeys, k.id]
                          : selectedKeys.filter((id) => id !== k.id),
                      )
                    }
                  />
                  <span className="font-mono">{k.key}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </Field>

      <Field
        label="Literal env"
        help="Plain KEY=value config, lowest precedence. NEVER put secret values here."
      >
        <div className="flex flex-col gap-2">
          {literalRows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                className="max-md:h-11 font-mono"
                value={row.key}
                placeholder="LOG_LEVEL"
                onChange={(e) =>
                  onLiteralRowsChange(
                    literalRows.map((r, idx) =>
                      idx === i ? { ...r, key: e.target.value } : r,
                    ),
                  )
                }
              />
              <span className="text-muted-foreground">=</span>
              <Input
                className="max-md:h-11 font-mono"
                value={row.value}
                placeholder="info"
                onChange={(e) =>
                  onLiteralRowsChange(
                    literalRows.map((r, idx) =>
                      idx === i ? { ...r, value: e.target.value } : r,
                    ),
                  )
                }
              />
              <Button
                variant="ghost"
                size="xs"
                className="max-md:h-11"
                onClick={() =>
                  onLiteralRowsChange(literalRows.filter((_, idx) => idx !== i))
                }
              >
                ✕
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="xs"
            className="max-md:h-11 self-start"
            onClick={() =>
              onLiteralRowsChange([...literalRows, { key: "", value: "" }])
            }
          >
            + Add config row
          </Button>
        </div>
      </Field>
    </SectionCard>
  );
}
