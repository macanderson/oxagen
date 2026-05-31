import { Database } from "lucide-react";

export default function KnowledgeSourcesPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60">
        <Database className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-base font-medium text-foreground">Sources</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Authenticated data connections and ingest pipelines. Connect a source and your
          agents gain access to the data within their knowledge graph.
        </p>
      </div>
    </div>
  );
}
