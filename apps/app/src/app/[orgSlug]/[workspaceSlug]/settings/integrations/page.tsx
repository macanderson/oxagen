import { Plug } from "lucide-react";

export default function SettingsIntegrationsPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60">
        <Plug className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-base font-medium text-foreground">Integrations</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Workspace-level webhook destinations. Route events, runs, and audit
          records to external systems from this workspace.
        </p>
      </div>
    </div>
  );
}
