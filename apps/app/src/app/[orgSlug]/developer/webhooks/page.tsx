import { Rss } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function DeveloperWebhooksPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-border/40 bg-muted/20 px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Rss className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="flex flex-col items-center gap-2">
        <Badge variant="outline" className="text-xs">
          Coming soon
        </Badge>
        <p className="text-sm font-medium text-foreground">Webhooks</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Webhook delivery is in development. You will be able to subscribe to
          real-time event payloads at your own HTTPS endpoints from this page.
        </p>
      </div>
    </div>
  );
}
