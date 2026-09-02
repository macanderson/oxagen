"use client";
/**
 * avatar-maker.tsx — the avatar editing experience shipped to user, workspace,
 * org, and agent settings alike.
 *
 * A single Dialog with two tabs:
 *   - Photo  — the exact upload+crop flow from `AvatarUpload`, reused via the
 *     shared `useCropUpload` hook + `CropSurface` (`../media/crop-upload.tsx`).
 *   - Design — pick an emoji, a background color, and a color mode; Save
 *     serializes the selection via `serializeDesignedAvatar` and calls
 *     `onChange` with the canonical `avatar:v1:` string.
 *
 * Opening the dialog pre-populates the Design tab from the current value (or
 * sensible defaults) and pre-selects the tab matching the current avatar kind.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { EntityAvatar, type EntityAvatarShape } from "./entity-avatar";
import { CropSurface, useCropUpload } from "../media/crop-upload";
import {
  parseAvatarValue,
  serializeDesignedAvatar,
  type AvatarMode,
} from "@/lib/avatar/spec";
import {
  EMOJI_CATEGORIES,
  ALL_EMOJI_ENTRIES,
  type EmojiEntry,
} from "./emoji-data";

export interface AvatarMakerProps {
  /** Current avatar value (image URL, `avatar:v1:` designed string, or null/undefined). */
  value: string | null | undefined;
  /** Called with the new canonical avatar value after Save (photo URL or designed string). */
  onChange: (value: string) => void;
  /** Entity display name — drives the live preview's initials fallback + accessible labels. */
  name: string;
  shape?: EntityAvatarShape;
  disabled?: boolean;
  /** Noun used in the dialog description, e.g. "agent", "workspace". Defaults to "profile". */
  entityLabel?: string;
}

type MakerTab = "photo" | "design";

interface DesignState {
  emoji: string;
  bg: string;
  mode: AvatarMode;
}

// Curated, brand-friendly background presets (lowercase #rrggbb — already
// canonical so they can be applied directly without round-tripping through
// serializeDesignedAvatar's normalization).
const BG_PRESETS: readonly string[] = [
  "#f59e0b", // amber
  "#f97316", // orange
  "#ef4444", // red
  "#ec4899", // pink
  "#d946ef", // fuchsia
  "#a855f7", // purple
  "#6366f1", // indigo
  "#3b82f6", // blue
  "#06b6d4", // cyan
  "#10b981", // emerald
  "#84cc16", // lime
  "#64748b", // slate
];

const DEFAULT_DESIGN: DesignState = {
  emoji: ALL_EMOJI_ENTRIES[0]?.emoji ?? "🙂",
  bg: BG_PRESETS[0] ?? "#f59e0b",
  mode: "full",
};

const HEX_INPUT_RE = /^#[0-9a-fA-F]{6}$/;

/** Derives the Design tab's initial fields + starting tab from the current value. */
function initialStateFromValue(value: string | null | undefined): {
  tab: MakerTab;
  design: DesignState;
} {
  const spec = parseAvatarValue(value);
  if (spec.kind === "designed") {
    return {
      tab: "design",
      design: { emoji: spec.emoji, bg: spec.bg, mode: spec.mode },
    };
  }
  return { tab: "photo", design: { ...DEFAULT_DESIGN } };
}

export function AvatarMaker({
  value,
  onChange,
  name,
  shape = "circle",
  disabled = false,
  entityLabel,
}: AvatarMakerProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<MakerTab>(
    () => initialStateFromValue(value).tab,
  );
  const [emoji, setEmoji] = React.useState<string>(
    () => initialStateFromValue(value).design.emoji,
  );
  const [bg, setBg] = React.useState<string>(
    () => initialStateFromValue(value).design.bg,
  );
  const [mode, setMode] = React.useState<AvatarMode>(
    () => initialStateFromValue(value).design.mode,
  );
  const [hexInput, setHexInput] = React.useState<string>(bg);
  const [hexError, setHexError] = React.useState<string | null>(null);
  const [category, setCategory] = React.useState<string>("all");
  const [search, setSearch] = React.useState("");

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const cropUpload = useCropUpload({
    onUploaded: (url) => {
      onChange(url);
      handleOpenChange(false);
    },
  });

  /** Re-derives every editable field from the current `value` — run on open. */
  const resetFromValue = React.useCallback(() => {
    const { tab, design } = initialStateFromValue(value);
    setActiveTab(tab);
    setEmoji(design.emoji);
    setBg(design.bg);
    setMode(design.mode);
    setHexInput(design.bg);
    setHexError(null);
    setCategory("all");
    setSearch("");
  }, [value]);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        resetFromValue();
      } else {
        cropUpload.reset();
      }
      setOpen(nextOpen);
    },
    [resetFromValue, cropUpload],
  );

  const handleFileChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      cropUpload.loadFile(file);
    },
    [cropUpload],
  );

  /** Applies a hex string from either the custom text field or the native color swatch. */
  const handleHexChange = React.useCallback((next: string) => {
    setHexInput(next);
    if (HEX_INPUT_RE.test(next)) {
      setBg(next.toLowerCase());
      setHexError(null);
    } else {
      setHexError("Enter a 6-digit hex color, e.g. #f59e0b");
    }
  }, []);

  const handlePickPreset = React.useCallback((preset: string) => {
    setBg(preset);
    setHexInput(preset);
    setHexError(null);
  }, []);

  const handleSaveDesign = React.useCallback(() => {
    const serialized = serializeDesignedAvatar({ emoji, bg, mode });
    onChange(serialized);
    handleOpenChange(false);
  }, [emoji, bg, mode, onChange, handleOpenChange]);

  // Live preview value for the Design tab — always valid since emoji/bg/mode
  // only ever hold already-validated state, but guarded defensively so a
  // transient invalid state never crashes the preview render.
  const previewValue = React.useMemo<string | null>(() => {
    try {
      return serializeDesignedAvatar({ emoji, bg, mode });
    } catch {
      return null;
    }
  }, [emoji, bg, mode]);

  const filteredEntries = React.useMemo<readonly EmojiEntry[]>(() => {
    const pool =
      category === "all"
        ? ALL_EMOJI_ENTRIES
        : (EMOJI_CATEGORIES.find((c) => c.id === category)?.entries ??
          ALL_EMOJI_ENTRIES);
    const query = search.trim().toLowerCase();
    if (!query) return pool;
    return pool.filter(
      (entry) =>
        entry.emoji === query || entry.keywords.some((k) => k.includes(query)),
    );
  }, [category, search]);

  const noun = entityLabel ?? "profile";
  const canSavePhoto = cropUpload.hasImage && cropUpload.canSave;

  return (
    <div className="flex items-center gap-4">
      <EntityAvatar value={value} name={name} shape={shape} size="xl" />

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger
          render={
            <Button variant="outline" className="h-10" disabled={disabled} />
          }
        >
          Edit avatar
        </DialogTrigger>

        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit avatar</DialogTitle>
            <DialogDescription>
              Choose a photo or design an icon avatar for this {noun}.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="gap-4">
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as MakerTab)}
            >
              <TabsList className="w-full">
                <TabsTab value="photo" className="flex-1">
                  Photo
                </TabsTab>
                <TabsTab value="design" className="flex-1">
                  Design
                </TabsTab>
              </TabsList>

              {/* ---------------------------------------------------------- */}
              {/* Photo tab — reuses the shared crop/upload internals        */}
              {/* ---------------------------------------------------------- */}
              <TabsPanel value="photo" className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="avatar-maker-file-input" className="sr-only">
                    Upload photo
                  </Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-10 self-start"
                    disabled={disabled || cropUpload.uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {cropUpload.hasImage
                      ? "Choose a different photo"
                      : "Choose a photo"}
                  </Button>
                  <input
                    ref={fileInputRef}
                    id="avatar-maker-file-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    disabled={disabled}
                    onChange={handleFileChange}
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                </div>

                {cropUpload.imageSrc ? (
                  <CropSurface
                    imageSrc={cropUpload.imageSrc}
                    shape={shape}
                    crop={cropUpload.crop}
                    zoom={cropUpload.zoom}
                    uploading={cropUpload.uploading}
                    error={cropUpload.error}
                    onCropChange={cropUpload.setCrop}
                    onZoomChange={cropUpload.setZoom}
                    onCropComplete={cropUpload.onCropComplete}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Pick a PNG, JPEG, or WebP photo to crop and upload.
                  </p>
                )}
              </TabsPanel>

              {/* ---------------------------------------------------------- */}
              {/* Design tab — emoji + background color + color mode        */}
              {/* ---------------------------------------------------------- */}
              <TabsPanel value="design" className="flex flex-col gap-4">
                <div className="flex items-center justify-center py-2">
                  <EntityAvatar
                    value={previewValue}
                    name={name}
                    shape={shape}
                    size="xl"
                  />
                </div>

                {/* Emoji picker */}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="avatar-maker-emoji-search">Icon</Label>
                  <Input
                    id="avatar-maker-emoji-search"
                    placeholder="Search icons…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <div
                    className="flex flex-wrap gap-1.5"
                    role="group"
                    aria-label="Emoji categories"
                  >
                    <Button
                      type="button"
                      size="sm"
                      className="h-10"
                      variant={category === "all" ? "secondary" : "ghost"}
                      onClick={() => setCategory("all")}
                    >
                      All
                    </Button>
                    {EMOJI_CATEGORIES.map((c) => (
                      <Button
                        key={c.id}
                        type="button"
                        size="sm"
                        className="h-10"
                        variant={category === c.id ? "secondary" : "ghost"}
                        onClick={() => setCategory(c.id)}
                      >
                        {c.label}
                      </Button>
                    ))}
                  </div>
                  <div
                    className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-8"
                    role="group"
                    aria-label="Choose an icon"
                  >
                    {filteredEntries.map((entry) => (
                      <button
                        key={entry.emoji}
                        type="button"
                        onClick={() => setEmoji(entry.emoji)}
                        aria-pressed={emoji === entry.emoji}
                        aria-label={entry.keywords[0] ?? "icon"}
                        className={cn(
                          "flex size-10 shrink-0 items-center justify-center rounded-md text-xl transition-colors hover:bg-muted",
                          emoji === entry.emoji && "bg-muted ring-2 ring-ring",
                        )}
                      >
                        <span aria-hidden="true">{entry.emoji}</span>
                      </button>
                    ))}
                    {filteredEntries.length === 0 && (
                      <p className="col-span-full py-4 text-center text-sm text-muted-foreground">
                        No icons match &ldquo;{search}&rdquo;.
                      </p>
                    )}
                  </div>
                </div>

                {/* Background color */}
                <div className="flex flex-col gap-2">
                  <Label>Background color</Label>
                  <div
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-label="Preset background colors"
                  >
                    {BG_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => handlePickPreset(preset)}
                        aria-pressed={bg === preset}
                        aria-label={`Background color ${preset}`}
                        className={cn(
                          "size-10 shrink-0 rounded-full ring-1 ring-border",
                          bg === preset &&
                            "ring-2 ring-ring ring-offset-2 ring-offset-background",
                        )}
                        style={{ backgroundColor: preset }}
                      />
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label="Custom background color picker"
                      value={HEX_INPUT_RE.test(hexInput) ? hexInput : bg}
                      onChange={(e) => handleHexChange(e.target.value)}
                      className="size-10 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
                    />
                    <Input
                      aria-label="Custom background color hex value"
                      value={hexInput}
                      onChange={(e) => handleHexChange(e.target.value)}
                      placeholder="#f59e0b"
                      className="h-10 max-w-[10rem]"
                    />
                  </div>
                  {hexError && (
                    <p className="text-sm text-destructive" role="alert">
                      {hexError}
                    </p>
                  )}
                </div>

                {/* Color mode */}
                <div className="flex flex-col gap-2">
                  <Label>Color mode</Label>
                  <SegmentedControl
                    value={mode}
                    onValueChange={(v) => setMode(v as AvatarMode)}
                  >
                    <SegmentedControlItem value="full">
                      Full color
                    </SegmentedControlItem>
                    <SegmentedControlItem value="mono-light">
                      Mono light
                    </SegmentedControlItem>
                    <SegmentedControlItem value="mono-dark">
                      Mono dark
                    </SegmentedControlItem>
                  </SegmentedControl>
                </div>
              </TabsPanel>
            </Tabs>
          </DialogPanel>

          <DialogFooter>
            <DialogClose
              render={
                <Button
                  variant="outline"
                  size="lg"
                  className="h-10"
                  disabled={cropUpload.uploading}
                />
              }
            >
              Cancel
            </DialogClose>

            {activeTab === "photo" ? (
              <Button
                size="lg"
                className="h-10"
                disabled={cropUpload.uploading || !canSavePhoto}
                onClick={() => void cropUpload.save()}
              >
                {cropUpload.uploading ? "Saving…" : "Save"}
              </Button>
            ) : (
              <Button
                size="lg"
                className="h-10"
                disabled={Boolean(hexError)}
                onClick={handleSaveDesign}
              >
                Save
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
