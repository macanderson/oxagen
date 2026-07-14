"use client";

/**
 * packages-section.tsx — the sandbox-template editor's "Packages" section.
 *
 * Each row binds a package manager (pip/npm/apt/…) to a set of package specs
 * entered as chips. A spec is free text so it may carry that ecosystem's own
 * version-pin syntax (e.g. `pydantic==2.5`, `serde@1`). The row model mirrors
 * the manifest's `packages: { manager, names[] }[]` exactly; empty rows are
 * dropped by `cleanPackages` before submit. Managers, options and per-manager
 * placeholders come from manifest-field-meta (schema-derived), so adding a
 * manager to the contract enum extends this dropdown with no change here.
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SandboxTemplatePackageGroup } from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import {
  PACKAGE_MANAGER_META,
  PACKAGE_MANAGER_OPTIONS,
} from "./manifest-field-meta";
import { Field, NativeSelect, SectionCard } from "./field-controls";

type Manager = SandboxTemplatePackageGroup["manager"];

const DEFAULT_MANAGER: Manager = PACKAGE_MANAGER_OPTIONS[0] ?? "pip";

/** Split a typed/pasted string into package tokens on any whitespace or comma. */
function tokenize(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

export function PackagesSection({
  packages,
  onPackagesChange,
}: {
  packages: SandboxTemplatePackageGroup[];
  onPackagesChange: (packages: SandboxTemplatePackageGroup[]) => void;
}) {
  const patchGroup = (
    i: number,
    partial: Partial<SandboxTemplatePackageGroup>,
  ) =>
    onPackagesChange(
      packages.map((g, idx) => (idx === i ? { ...g, ...partial } : g)),
    );

  const addNames = (i: number, tokens: string[]) => {
    const group = packages[i];
    if (!group) return;
    const merged = [...group.names];
    for (const t of tokens) if (!merged.includes(t)) merged.push(t);
    patchGroup(i, { names: merged });
  };

  const removeName = (i: number, name: string) => {
    const group = packages[i];
    if (!group) return;
    patchGroup(i, { names: group.names.filter((n) => n !== name) });
  };

  const removeLast = (i: number) => {
    const group = packages[i];
    if (!group || group.names.length === 0) return;
    patchGroup(i, { names: group.names.slice(0, -1) });
  };

  return (
    <SectionCard
      title="Packages"
      description="Specify packages and their versions available in this environment. Separate multiple values with spaces."
    >
      <Field label="Packages">
        <div className="flex flex-col gap-2">
          {packages.map((group, i) => (
            <div key={i} className="flex items-start gap-2">
              <NativeSelect
                data-testid={`sandbox-template-package-manager-${i}`}
                value={group.manager}
                onChange={(v) => patchGroup(i, { manager: v as Manager })}
              >
                {PACKAGE_MANAGER_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {PACKAGE_MANAGER_META[m].label}
                  </option>
                ))}
              </NativeSelect>

              <PackageChipInput
                index={i}
                names={group.names}
                placeholder={PACKAGE_MANAGER_META[group.manager].placeholder}
                onAdd={(tokens) => addNames(i, tokens)}
                onRemove={(name) => removeName(i, name)}
                onRemoveLast={() => removeLast(i)}
              />

              <Button
                variant="ghost"
                size="xs"
                className="max-md:h-11"
                aria-label="Remove package manager"
                onClick={() =>
                  onPackagesChange(packages.filter((_, idx) => idx !== i))
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
            data-testid="sandbox-template-add-package"
            onClick={() =>
              onPackagesChange([
                ...packages,
                { manager: DEFAULT_MANAGER, names: [] },
              ])
            }
          >
            + Add package manager
          </Button>
        </div>
      </Field>
    </SectionCard>
  );
}

/**
 * A wrapping token/chip input: existing package specs render as removable
 * Badges, and typing commits a token on whitespace, comma, or Enter. Backspace
 * on an empty field removes the last chip. onBlur commits any pending draft so
 * a value typed but not separated is never silently lost.
 */
function PackageChipInput({
  index,
  names,
  placeholder,
  onAdd,
  onRemove,
  onRemoveLast,
}: {
  index: number;
  names: string[];
  placeholder: string;
  onAdd: (tokens: string[]) => void;
  onRemove: (name: string) => void;
  onRemoveLast: () => void;
}) {
  const [draft, setDraft] = React.useState("");

  const commit = () => {
    const tokens = tokenize(draft);
    if (tokens.length > 0) onAdd(tokens);
    setDraft("");
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // A separator in the stream commits every completed token, keeping only the
    // trailing partial in the field (so "fastapi pydantic" chips "fastapi").
    if (/[\s,]/.test(value)) {
      const parts = value.split(/[\s,]+/);
      const trailing = parts.pop() ?? "";
      const tokens = parts.map((t) => t.trim()).filter((t) => t !== "");
      if (tokens.length > 0) onAdd(tokens);
      setDraft(trailing);
    } else {
      setDraft(value);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "" && names.length > 0) {
      e.preventDefault();
      onRemoveLast();
    }
  };

  return (
    <div className="flex min-h-9 flex-1 flex-wrap items-center gap-1 rounded-md border border-border/50 bg-background px-2 py-1 max-md:min-h-11">
      {names.map((name) => (
        <Badge key={name} variant="muted" className="gap-1 font-mono">
          <span>{name}</span>
          <button
            type="button"
            aria-label={`Remove ${name}`}
            className="opacity-70 hover:opacity-100"
            onClick={() => onRemove(name)}
          >
            ✕
          </button>
        </Badge>
      ))}
      <input
        data-testid={`sandbox-template-package-input-${index}`}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        value={draft}
        placeholder={names.length === 0 ? placeholder : ""}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    </div>
  );
}
