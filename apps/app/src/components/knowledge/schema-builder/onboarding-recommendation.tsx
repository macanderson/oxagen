"use client";

import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { recommend } from "./schema-service";
import type { TenantSlugs, LabelItem } from "./types";
import type { SchemaRecommendOutput } from "./schema-service";

interface OnboardingRecommendationProps {
  slugs: TenantSlugs;
  onApply: (schemaName: string, labels: LabelItem[]) => Promise<void>;
  onDiscard: () => void;
}

export function OnboardingRecommendation({
  slugs,
  onApply,
  onDiscard,
}: OnboardingRecommendationProps) {
  const [sampleLimit, setSampleLimit] = React.useState(200);
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<SchemaRecommendOutput | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [applyingSchema, setApplyingSchema] = React.useState<string | null>(
    null,
  );

  const fetchRecommendation = React.useCallback(
    async (limit: number) => {
      setLoading(true);
      setError(null);
      try {
        const data = await recommend(slugs, { sampleLimit: limit });
        setResult(data);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Failed to get recommendations",
        );
      } finally {
        setLoading(false);
      }
    },
    [slugs],
  );

  React.useEffect(() => {
    void fetchRecommendation(sampleLimit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSampleMore = () => {
    const newLimit = Math.min(sampleLimit * 2, 2000);
    setSampleLimit(newLimit);
    void fetchRecommendation(newLimit);
  };

  const handleApply = async (
    schemaName: string,
    schema: SchemaRecommendOutput["proposal"]["schemas"][number],
  ) => {
    setApplyingSchema(schemaName);
    try {
      const labels: LabelItem[] = schema.labels.map((l) => ({
        name: l.name,
        displayName: l.name,
        description: l.description,
        properties: l.properties?.map((p) => ({
          key: p.key,
          dataType: p.dataType,
          required: p.required,
          description: p.description,
        })),
      }));
      await onApply(schemaName, labels);
    } finally {
      setApplyingSchema(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">Sample size</p>
          <p className="text-xs text-muted-foreground">
            Nodes sampled: {sampleLimit}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                const newLimit = Math.max(50, sampleLimit - 50);
                setSampleLimit(newLimit);
              }}
              disabled={loading || sampleLimit <= 50}
              aria-label="Decrease sample size"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            <span className="text-sm w-12 text-center">{sampleLimit}</span>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                const newLimit = Math.min(2000, sampleLimit + 50);
                setSampleLimit(newLimit);
              }}
              disabled={loading || sampleLimit >= 2000}
              aria-label="Increase sample size"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSampleMore}
            disabled={loading || sampleLimit >= 2000}
          >
            Sample more
          </Button>
        </div>
      </div>

      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && result && (
        <div className="space-y-3">
          {result.proposal.schemas.map((schema) => (
            <div
              key={schema.name}
              className="rounded-xl border border-border bg-card p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{schema.displayName}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {schema.labels.length} label
                    {schema.labels.length !== 1 ? "s" : ""}
                    {" · "}
                    {schema.relationshipTypes.length} relationship type
                    {schema.relationshipTypes.length !== 1 ? "s" : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => void handleApply(schema.name, schema)}
                  disabled={applyingSchema === schema.name}
                >
                  {applyingSchema === schema.name ? "Applying…" : "Accept"}
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {schema.labels.map((l) => (
                  <span
                    key={l.name}
                    className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs"
                    title={l.description}
                  >
                    {l.name}
                    {l.properties && l.properties.length > 0 && (
                      <span className="ml-1 text-muted-foreground">
                        ({l.properties.length})
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}

          <div
            className={cn(
              "rounded-xl border border-border bg-muted/30 px-4 py-3",
            )}
          >
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
              Rationale
            </p>
            <p className="text-sm text-muted-foreground">{result.rationale}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Based on {result.sampledCount} sampled nodes.
            </p>
          </div>

          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={onDiscard}>
              Discard all
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
