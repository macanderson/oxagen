import { Webhook } from "lucide-react";

export default function DeveloperWebhooksPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-border/60 bg-muted/30 px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Webhook className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">Outbound webhooks</p>
        <p className="text-xs text-muted-foreground">
          Route events, runs, and audit entries to external systems. Coming soon.
        </p>
      </div>
    </div>
  );
}
