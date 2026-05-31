import { Palette } from "lucide-react";

export default function SettingsBrandKitsPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60">
        <Palette className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-base font-medium text-foreground">Brand kits</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Style configurations that constrain Studio output — voice, tone, color,
          and typography. Apply a brand kit when composing to stay on-brand.
        </p>
      </div>
    </div>
  );
}
