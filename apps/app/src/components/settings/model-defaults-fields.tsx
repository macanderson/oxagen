"use client";
/**
 * ModelDefaultsFields — shared model-default selection UI.
 *
 * Used by:
 *   - apps/app/src/app/account/preferences/preferences-form.tsx (user scope)
 *   - workspace settings agent (workspace scope) — imports this exact path
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
  supportsImage,
  supportsVideo,
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
  /** Image-capable gateway slug. */
  imageModel: string | null;
  /** Video-capable gateway slug. */
  videoModel: string | null;
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

const imageModels: GatewayModel[] = gatewayModels.filter((m) =>
  supportsImage(m),
);
const videoModels: GatewayModel[] = gatewayModels.filter((m) =>
  supportsVideo(m),
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
  const imageValue = value.imageModel ?? SYSTEM_VALUE;
  const videoValue = value.videoModel ?? SYSTEM_VALUE;

  const multimodalByVendor = groupByVendor(multimodalTextModels);
  const imageByVendor = groupByVendor(imageModels);
  const videoByVendor = groupByVendor(videoModels);

  const scopeNote =
    scope === "user"
      ? "A workspace can override these defaults when you're in that workspace."
      : "These defaults apply to all members of this workspace.";

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

  function handleImageChange(encoded: string | null): void {
    onChange({
      ...value,
      imageModel: !encoded || encoded === SYSTEM_VALUE ? null : encoded,
    });
  }

  function handleVideoChange(encoded: string | null): void {
    onChange({
      ...value,
      videoModel: !encoded || encoded === SYSTEM_VALUE ? null : encoded,
    });
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

      {/* ── Default image model ── */}
      <div className="flex flex-col gap-1.5">
        <Label>Default image model</Label>
        <Select
          value={imageValue}
          onValueChange={handleImageChange}
          disabled={disabled}
        >
          <SelectTrigger
            size="default"
            className="w-full max-w-sm"
            aria-label="Default image model"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup className="w-[var(--available-width)]">
            <SelectItem value={SYSTEM_VALUE}>
              <span className="font-medium">System default</span>
              <span className="ml-2 text-xs text-muted-foreground">
                Oxagen selects automatically
              </span>
            </SelectItem>
            {imageModels.length > 0 && (
              <SelectGroup>
                <SelectLabel>Image models</SelectLabel>
                {Array.from(imageByVendor.entries()).map(([vendor, models]) => (
                  <React.Fragment key={vendor}>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="font-medium">{m.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {vendorLabels[vendor]}
                        </span>
                      </SelectItem>
                    ))}
                  </React.Fragment>
                ))}
              </SelectGroup>
            )}
          </SelectPopup>
        </Select>
      </div>

      {/* ── Default video model ── */}
      <div className="flex flex-col gap-1.5">
        <Label>Default video model</Label>
        <Select
          value={videoValue}
          onValueChange={handleVideoChange}
          disabled={disabled}
        >
          <SelectTrigger
            size="default"
            className="w-full max-w-sm"
            aria-label="Default video model"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup className="w-[var(--available-width)]">
            <SelectItem value={SYSTEM_VALUE}>
              <span className="font-medium">System default</span>
              <span className="ml-2 text-xs text-muted-foreground">
                Oxagen selects automatically
              </span>
            </SelectItem>
            {videoModels.length > 0 && (
              <SelectGroup>
                <SelectLabel>Video models</SelectLabel>
                {Array.from(videoByVendor.entries()).map(([vendor, models]) => (
                  <React.Fragment key={vendor}>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="font-medium">{m.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {vendorLabels[vendor]}
                        </span>
                      </SelectItem>
                    ))}
                  </React.Fragment>
                ))}
              </SelectGroup>
            )}
          </SelectPopup>
        </Select>
      </div>

      <p className="text-xs text-muted-foreground">{scopeNote}</p>
    </div>
  );
}
