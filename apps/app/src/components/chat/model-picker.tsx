"use client";
import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  gatewayModels,
  vendorLabels,
  getModel,
  supportsImage,
  supportsVideo,
  supportsText,
  capabilityLabel,
  formatReleaseDate,
  TEXT_TIERS,
  MEDIA_TIERS,
} from "@oxagen/ai/catalog";
import type {
  TextTier,
  MediaTier,
  MediaKind,
  EffortLevel,
  ResolvedTierCatalog,
  Vendor,
} from "@oxagen/ai/catalog";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
  MenuGroupLabel,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "@/components/ui/menu";

// ─── State shape ──────────────────────────────────────────────────────────────

export interface ComposerModelState {
  /** null = text chat, "image"/"video" = media generation */
  generate: MediaKind | null;
  /** Selected text tier (mutually exclusive with `model`) */
  tier: TextTier | null;
  /** Explicit "Other Models" gateway model id for text */
  model: string | null;
  /** Reasoning level (text only) */
  effort: EffortLevel | null;
  /** Selected media tier */
  mediaTier: MediaTier | null;
  /** Explicit "Other Models" gateway model id for media */
  mediaModel: string | null;
}

export const defaultModelState: ComposerModelState = {
  generate: null,
  tier: "fast",
  model: null,
  effort: "medium",
  mediaTier: "basic",
  mediaModel: null,
};

/**
 * Seed properties for ComposerModelState derived from effective model defaults
 * resolved server-side (workspace > user > system). Passed once at mount time;
 * the user can still override per-turn via the ModelPicker.
 */
export interface ModelStateSeed {
  /** Explicit text model id to pre-select (wins over tier when set). */
  textModel: string | null;
  /** Text tier to pre-select (used only when textModel is null). */
  textTier: TextTier | null;
  /** Image model id to pre-select in image-generation mode. */
  imageModel: string | null;
  /** Video model id to pre-select in video-generation mode. */
  videoModel: string | null;
}

/** Build the initial ComposerModelState from seeded effective defaults. */
export function buildSeededModelState(seed: ModelStateSeed): ComposerModelState {
  return {
    generate: null,
    tier: seed.textModel ? null : (seed.textTier ?? "fast"),
    model: seed.textModel ?? null,
    effort: "medium",
    mediaTier: seed.imageModel || seed.videoModel ? null : "basic",
    mediaModel: null,
  };
}

// ─── Vendor indicator tile ────────────────────────────────────────────────────

/** A small neutral tile showing the vendor's first letter — no image assets. */
function VendorTile({ vendor }: { vendor: Vendor }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid h-5 w-5 shrink-0 place-items-center rounded border border-border bg-muted/60 font-mono text-[10px] font-semibold uppercase text-muted-foreground"
    >
      {vendorLabels[vendor][0]}
    </span>
  );
}

// ─── "Other Models" flyout list ───────────────────────────────────────────────

interface OtherModelsListProps {
  generate: MediaKind | null;
  activeModelId: string | null;
  onSelect: (id: string) => void;
}

function OtherModelsList({ generate, activeModelId, onSelect }: OtherModelsListProps) {
  return (
    <div className="max-h-80 overflow-y-auto py-1">
      {gatewayModels.map((m) => {
        const disabled =
          generate === null
            ? !supportsText(m)
            : generate === "image"
              ? !supportsImage(m)
              : !supportsVideo(m);
        const isActive = activeModelId === m.id;

        return (
          <button
            key={m.id}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (!disabled) onSelect(m.id);
            }}
            aria-pressed={isActive}
            className={cn(
              "flex w-full items-start gap-2.5 rounded-sm px-3 py-2 text-left text-sm transition-colors",
              disabled
                ? "cursor-not-allowed opacity-40"
                : "cursor-pointer hover:bg-accent hover:text-accent-foreground",
              isActive && "bg-accent/50",
            )}
          >
            <VendorTile vendor={m.vendor} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-medium">{m.name}</span>
                {isActive && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                )}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {vendorLabels[m.vendor]}
                {" · "}
                {formatReleaseDate(m.released)}
                {m.context ? ` · ${m.context}` : ""}
              </span>
              <span className="mt-1 flex flex-wrap gap-1">
                {m.capabilities.map((c) => (
                  <span
                    key={c}
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
                  >
                    {capabilityLabel(c)}
                  </span>
                ))}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── ModelPicker ──────────────────────────────────────────────────────────────

export interface ModelPickerProps {
  value: ComposerModelState;
  onChange: (s: ComposerModelState) => void;
  modelConfig: ResolvedTierCatalog;
}

export function ModelPicker({ value, onChange, modelConfig }: ModelPickerProps) {
  // Compute the display label for the trigger button.
  const triggerLabel = React.useMemo<string>(() => {
    if (value.generate === null) {
      // Text mode
      if (value.model) {
        return getModel(value.model)?.name ?? value.model;
      }
      const tier = TEXT_TIERS.find((t) => t.id === (value.tier ?? "fast"));
      return tier?.name ?? "Oxagen Fast";
    }
    // Media mode
    if (value.mediaModel) {
      return getModel(value.mediaModel)?.name ?? value.mediaModel;
    }
    const tiers = MEDIA_TIERS;
    const mediaTier = tiers.find((t) => t.id === (value.mediaTier ?? "basic"));
    return mediaTier?.name ?? "Oxagen Basic";
  }, [value]);

  // Resolved tier config for the current generate mode.
  const tierMap = value.generate === "image"
    ? modelConfig.image
    : value.generate === "video"
      ? modelConfig.video
      : modelConfig.text;

  const panelHeader =
    value.generate === "image"
      ? "Oxagen image models"
      : value.generate === "video"
        ? "Oxagen video models"
        : "Oxagen models";

  // Handler: select a text tier.
  function selectTextTier(id: TextTier) {
    onChange({ ...value, tier: id, model: null });
  }

  // Handler: select a media tier.
  function selectMediaTier(id: MediaTier) {
    onChange({ ...value, mediaTier: id, mediaModel: null });
  }

  // Handler: select an explicit gateway model.
  function selectOtherModel(id: string) {
    if (value.generate === null) {
      onChange({ ...value, model: id, tier: null });
    } else {
      onChange({ ...value, mediaModel: id, mediaTier: null });
    }
  }

  const activeExplicitModel =
    value.generate === null ? value.model : value.mediaModel;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Model: ${triggerLabel}`}
            className="h-8 gap-1.5 px-2 text-xs font-medium"
          />
        }
      >
        <span className="max-w-[140px] truncate">{triggerLabel}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </MenuTrigger>

      <MenuPopup
        sideOffset={8}
        align="start"
        className="w-72 p-0"
      >
        {/* Header */}
        <MenuGroupLabel className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          {panelHeader}
        </MenuGroupLabel>

        <div className="p-1">
          {/* Primary tier list */}
          {value.generate === null ? (
            // Text tiers
            TEXT_TIERS.map((t) => {
              const resolvedId = modelConfig.text[t.id];
              const resolvedName = getModel(resolvedId)?.name ?? resolvedId;
              const isActive = value.model === null && value.tier === t.id;

              return (
                <MenuItem
                  key={t.id}
                  onClick={() => selectTextTier(t.id)}
                  className="flex-col items-start gap-0 px-3 py-2"
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span className="flex-1 text-sm font-medium">{t.name}</span>
                    {isActive && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{t.blurb}</span>
                  <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground/70">
                    {resolvedName}
                  </span>
                </MenuItem>
              );
            })
          ) : (
            // Media tiers (image or video)
            MEDIA_TIERS.map((t) => {
              const resolvedId = (tierMap as Record<string, string | undefined>)[t.id] ?? t.id;
              const resolvedName = getModel(resolvedId)?.name ?? resolvedId;
              const isActive = value.mediaModel === null && value.mediaTier === t.id;

              return (
                <MenuItem
                  key={t.id}
                  onClick={() => selectMediaTier(t.id)}
                  className="flex-col items-start gap-0 px-3 py-2"
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span className="flex-1 text-sm font-medium">{t.name}</span>
                    {isActive && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{t.blurb}</span>
                  <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground/70">
                    {resolvedName}
                  </span>
                </MenuItem>
              );
            })
          )}

          <MenuSeparator />

          {/* "Other Models" — hover-opening submenu */}
          <MenuSub>
            <MenuSubTrigger className="w-full px-3 py-2 text-sm">
              Other models
            </MenuSubTrigger>
            <MenuSubPopup
              side="right"
              align="start"
              sideOffset={4}
              className="w-80 p-0"
            >
              <OtherModelsList
                generate={value.generate}
                activeModelId={activeExplicitModel}
                onSelect={selectOtherModel}
              />
            </MenuSubPopup>
          </MenuSub>
        </div>
      </MenuPopup>
    </Menu>
  );
}
