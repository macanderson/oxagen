"use client";
/**
 * ModelDefaultsFields — shared model-default selection UI.
 *
 * Used by:
 *   - apps/app/src/app/account/preferences/preferences-form.tsx (user scope)
 *   - workspace settings agent (workspace scope) — imports this exact path
 *
 * ADR-043 removed image/video generation from the platform, so the only stored
 * default dimension is text (an Oxagen tier or an explicit model id).
 *
 * Contract (do not change signatures without coordinating with the workspace
 * settings agent):
 *
 *   import { ModelDefaultsFields } from "@/components/settings/model-defaults-fields"
 *   import type { ModelDefaultsValue, ModelDefaultsFieldsProps } from "@/components/settings/model-defaults-fields"
 */
import * as React from "react";
import {
  gatewayModels,
  TEXT_TIERS,
  vendorLabels,
  supportsText,
  type GatewayModel,
} from "@oxagen/ai/catalog";
import type { Vendor } from "@oxagen/ai/catalog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectGroup,
  SelectLabel,
  SelectItem,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

// ── Public contract types ────────────────────────────────────────────────────

/**
 * The model-defaults value shape. Mirrors user/workspace preferences columns.
 *
 * Semantics:
 *   - textModel wins over textTier when both are non-null.
 *   - Setting textModel → set textModel, clear textTier.
 *   - Setting a tier → set textTier, clear textModel.
 *   - System default → both null.
 */
export interface ModelDefaultsValue {
  /** When set, the agent uses this Oxagen tier. */
  textTier: "fast" | "balanced" | "precise" | null;
  /** Explicit vision/multimodal gateway slug; when set, WINS over textTier. */
  textModel: string | null;
}

export interface ModelDefaultsFieldsProps {
  value: ModelDefaultsValue;
  onChange: (next: ModelDefaultsValue) => void;
  /** Affects helper copy only — "user" or "workspace". */
  scope: "user" | "workspace";
  disabled?: boolean;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Multimodal text models: supports text + vision, is NOT image-only / video-only. */
const multimodalTextModels: GatewayModel[] = gatewayModels.filter(
  (m) =>
    supportsText(m) &&
    m.capabilities.includes("vision") &&
    !m.capabilities.includes("image") &&
    !m.capabilities.includes("video"),
);

/** Group a list of models by vendor, return ordered vendor→model map. */
function groupByVendor(models: GatewayModel[]): Map<Vendor, GatewayModel[]> {
  const map = new Map<Vendor, GatewayModel[]>();
  for (const m of models) {
    const group = map.get(m.vendor) ?? [];
    group.push(m);
    map.set(m.vendor, group);
  }
  return map;
}

// ── Text select value encoding ───────────────────────────────────────────────
// A single <select> encodes three mutually exclusive states via a string value:
//   "system"         → both null
//   "tier:<id>"      → textTier = id, textModel = null
//   "model:<id>"     → textModel = id, textTier = null

const SYSTEM_VALUE = "system";

function encodeTextValue(
  textModel: string | null,
  textTier: "fast" | "balanced" | "precise" | null,
): string {
  if (textModel) return `model:${textModel}`;
  if (textTier) return `tier:${textTier}`;
  return SYSTEM_VALUE;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ModelDefaultsFields({
  value,
  onChange,
  scope,
  disabled = false,
}: ModelDefaultsFieldsProps): React.JSX.Element {
  const textValue = encodeTextValue(value.textModel, value.textTier);

  const multimodalByVendor = groupByVendor(multimodalTextModels);

  const scopeNote =
    scope === "user"
      ? "A workspace can override this default when you're in that workspace."
      : "This default applies to all members of this workspace.";

  // ── Handler: text model/tier change ──────────────────────────────────────

  function handleTextChange(encoded: string | null): void {
    if (!encoded || encoded === SYSTEM_VALUE) {
      onChange({ ...value, textTier: null, textModel: null });
    } else if (encoded.startsWith("tier:")) {
      const tier = encoded.slice(5) as "fast" | "balanced" | "precise";
      onChange({ ...value, textTier: tier, textModel: null });
    } else if (encoded.startsWith("model:")) {
      const modelId = encoded.slice(6);
      onChange({ ...value, textModel: modelId, textTier: null });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ── Default agent model ── */}
      <div className="flex flex-col gap-1.5">
        <Label>Default agent model</Label>
        <Select
          value={textValue}
          onValueChange={handleTextChange}
          disabled={disabled}
        >
          <SelectTrigger
            size="default"
            className="w-full max-w-sm"
            aria-label="Default agent model"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup className="w-[var(--available-width)]">
            {/* System default */}
            <SelectItem value={SYSTEM_VALUE}>
              <span className="font-medium">System default</span>
              <span className="ml-2 text-xs text-muted-foreground">
                Oxagen selects automatically
              </span>
            </SelectItem>

            {/* Oxagen tiers */}
            <SelectGroup>
              <SelectLabel>Oxagen tiers</SelectLabel>
              {TEXT_TIERS.map((tier) => (
                <SelectItem key={tier.id} value={`tier:${tier.id}`}>
                  <span className="font-medium">{tier.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {tier.blurb}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>

            {/* Multimodal models grouped by vendor */}
            {multimodalTextModels.length > 0 && (
              <SelectGroup>
                <SelectLabel>Other models</SelectLabel>
                {Array.from(multimodalByVendor.entries()).map(
                  ([vendor, models]) => (
                    <React.Fragment key={vendor}>
                      {models.map((m) => (
                        <SelectItem key={m.id} value={`model:${m.id}`}>
                          <span className="font-medium">{m.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {vendorLabels[vendor]}
                            {m.context ? ` · ${m.context}` : ""}
                          </span>
                        </SelectItem>
                      ))}
                    </React.Fragment>
                  ),
                )}
              </SelectGroup>
            )}
          </SelectPopup>
        </Select>
      </div>

      <p className="text-xs text-muted-foreground">{scopeNote}</p>
    </div>
  );
}
