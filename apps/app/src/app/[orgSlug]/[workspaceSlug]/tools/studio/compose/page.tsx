import { Wand2 } from "lucide-react";

export default function StudioComposePage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60">
        <Wand2 className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-base font-medium text-foreground">Compose</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Prompt-to-preview content generation. Brand kit selection pulls from
          workspace settings. Completed generations appear in Activity — Runs.
        </p>
      </div>
    </div>
  );
}
