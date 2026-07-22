"use client";
/**
 * ProviderModelPicker — a cascading Provider → Model selector.
 *
 * Two labelled {@link Select}s side by side (stacked on narrow viewports). The
 * first picks a catalog {@link Vendor} (rendered with its {@link ProviderIcon}
 * brand mark); the second lists that vendor's text-capable models. It is fully
 * self-contained and reusable — instantiate it twice (e.g. a target-model
 * picker and a judge-model picker) with independent `value` / `onChange` and a
 * distinct `idPrefix` for accessible label wiring.
 *
 * Selection is a single gateway model id (or `null` for the "Default tier"
 * choice). The vendor half of the cascade is derived state — the current
 * vendor is `getModel(value)?.vendor` — but a local override lets the model
 * list populate after a provider is chosen but before a model is.
 */
import * as React from "react";
import {
  gatewayModels,
  vendorLabels,
  getModel,
  supportsText,
  type GatewayModel,
  type Vendor,
} from "@oxagen/ai/catalog";
import { posturesFor } from "@oxagen/ai/posture";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ProviderIcon } from "./provider-icon";
import { PostureBadgeGroup } from "./posture-badges";

// ── Public contract ──────────────────────────────────────────────────────────

export interface ProviderModelPickerProps {
  /** Selected gateway model id, or `null` = "Default tier". */
  value: string | null;
  onChange: (modelId: string | null) => void;
  /** Adds a "Default tier" choice (value `null`). Default `true`. */
  includeDefaultOption?: boolean;
  /** Label for the default choice. Default "Default tier". */
  defaultOptionLabel?: string;
  disabled?: boolean;
  /** Namespaces the label/select ids so multiple instances stay unique. */
  idPrefix?: string;
  /** Provider select label. Default "Provider". */
  providerLabel?: string;
  /** Model select label. Default "Model". */
  modelLabel?: string;
}

// ── Derived catalog data (module-level, computed once) ────────────────────────

/** Every text-capable model, indexed once at module load. */
const TEXT_MODELS: GatewayModel[] = gatewayModels.filter((m) =>
  supportsText(m),
);

/**
 * Preferred vendor ordering: the three flagship providers first, then the rest
 * alphabetically by display label. Only vendors with ≥1 text-capable model are
 * surfaced.
 */
const PREFERRED_ORDER: Vendor[] = ["anthropic", "openai", "google"];

const TEXT_VENDORS: Vendor[] = (() => {
  const present = new Set<Vendor>(TEXT_MODELS.map((m) => m.vendor));
  const preferred = PREFERRED_ORDER.filter((v) => present.has(v));
  const rest = [...present]
    .filter((v) => !PREFERRED_ORDER.includes(v))
    .sort((a, b) => vendorLabels[a].localeCompare(vendorLabels[b]));
  return [...preferred, ...rest];
})();

/** Text-capable models for a given vendor, in catalog order. */
function modelsForVendor(vendor: Vendor): GatewayModel[] {
  return TEXT_MODELS.filter((m) => m.vendor === vendor);
}

// The provider <Select> encodes "no provider" (the default option) as a
// sentinel string, because Base UI's Select uses "" as its own unset marker.
const NO_PROVIDER = "__default__";

// ── Component ────────────────────────────────────────────────────────────────

export function ProviderModelPicker({
  value,
  onChange,
  includeDefaultOption = true,
  defaultOptionLabel = "Default tier",
  disabled = false,
  idPrefix = "provider-model",
  providerLabel = "Provider",
  modelLabel = "Model",
}: ProviderModelPickerProps): React.JSX.Element {
  // The vendor implied by the current value (source of truth when a model is
  // selected).
  const valueVendor = value ? (getModel(value)?.vendor ?? null) : null;

  // Local provider override — the source of truth for the provider dropdown.
  // Seeded from the value's vendor, and (below) synced UP when the controlled
  // value is externally set to a model from a different vendor. It is NOT reset
  // when value is null: after the user picks a provider, value stays null (they
  // haven't chosen a model yet) but the vendor must persist so the model list
  // populates — that is the whole point of the cascade.
  const [chosenVendor, setChosenVendor] = React.useState<Vendor | null>(
    valueVendor,
  );

  // Follow an EXTERNALLY-driven value change: when the controlled value points
  // at a model whose vendor differs from the local choice (e.g. a parent form
  // reset or programmatic set), adopt that vendor. Clearing to null is handled
  // locally by the option handlers, not here — so a fresh provider pick is not
  // immediately undone.
  React.useEffect(() => {
    if (valueVendor && valueVendor !== chosenVendor) {
      setChosenVendor(valueVendor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow value only
  }, [value, valueVendor]);

  const activeVendor = chosenVendor;
  const modelOptions = activeVendor ? modelsForVendor(activeVendor) : [];

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleProviderChange(next: string | null): void {
    if (!next || next === NO_PROVIDER) {
      // Default option selected → clear both provider and model.
      setChosenVendor(null);
      onChange(null);
      return;
    }
    const vendor = next as Vendor;
    setChosenVendor(vendor);
    const models = modelsForVendor(vendor);
    if (includeDefaultOption) {
      // Clear the model so the user must explicitly pick one from this vendor.
      onChange(null);
    } else {
      // No default choice — auto-select the vendor's first model so the
      // selection is never empty.
      onChange(models[0]?.id ?? null);
    }
  }

  function handleModelChange(next: string | null): void {
    if (!next) {
      onChange(null);
      return;
    }
    onChange(next);
  }

  // ── Select values ─────────────────────────────────────────────────────────

  const providerValue =
    activeVendor ?? (includeDefaultOption ? NO_PROVIDER : "");
  // The model select value is the raw id, or "" (unset) when no model is chosen.
  const modelValue = value ?? "";

  const providerLabelId = `${idPrefix}-provider-label`;
  const modelLabelId = `${idPrefix}-model-label`;
  const modelSelectDisabled = disabled || activeVendor === null;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
      {/* ── Provider ── */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label id={providerLabelId} htmlFor={`${idPrefix}-provider`}>
          {providerLabel}
        </Label>
        <Select
          value={providerValue}
          onValueChange={handleProviderChange}
          disabled={disabled}
        >
          <SelectTrigger
            id={`${idPrefix}-provider`}
            size="default"
            className="w-full"
            aria-labelledby={providerLabelId}
          >
            <SelectValue placeholder="Select provider">
              {activeVendor ? (
                <span className="flex items-center gap-2">
                  <ProviderIcon vendor={activeVendor} />
                  <span className="truncate">{vendorLabels[activeVendor]}</span>
                </span>
              ) : null}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup className="w-[var(--available-width)]">
            {includeDefaultOption && (
              <SelectItem value={NO_PROVIDER}>
                <span className="font-medium">{defaultOptionLabel}</span>
              </SelectItem>
            )}
            {TEXT_VENDORS.map((vendor) => (
              <SelectItem key={vendor} value={vendor}>
                <span className="flex items-center gap-2">
                  <ProviderIcon vendor={vendor} />
                  <span className="truncate">{vendorLabels[vendor]}</span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {/* Capability posture — resolved once per vendor (not per model:
            every model from a vendor shares the same cache/reasoning/
            structured-output/attachment posture), so it lives here rather
            than inside each model <SelectItem>, which has no room for it. */}
        {activeVendor && (
          <PostureBadgeGroup
            posture={posturesFor(activeVendor)}
            vendorLabel={vendorLabels[activeVendor]}
            className="mt-0.5"
          />
        )}
      </div>

      {/* ── Model ── */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label id={modelLabelId} htmlFor={`${idPrefix}-model`}>
          {modelLabel}
        </Label>
        <Select
          value={modelValue}
          onValueChange={handleModelChange}
          disabled={modelSelectDisabled}
        >
          <SelectTrigger
            id={`${idPrefix}-model`}
            size="default"
            className="w-full"
            aria-labelledby={modelLabelId}
          >
            <SelectValue
              placeholder={
                activeVendor ? "Select model" : "Choose a provider first"
              }
            />
          </SelectTrigger>
          <SelectPopup className="w-[var(--available-width)]">
            {modelOptions.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="font-medium">{m.name}</span>
                {m.context ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {m.context}
                  </span>
                ) : null}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}
