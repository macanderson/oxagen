"use client";

/**
 * sync-cadence-panel.tsx — Sync delivery mode configuration.
 *
 * Radio buttons: manual / polling / webhook
 * Polling interval input (seconds, with min/max validation)
 */

import * as React from "react";
import { RadioGroup, Radio } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConnectorSchema } from "./connector-schema-provider";
import { cn } from "@oxagen/ui";

const SYNC_MODE_KEY = "syncMode";
const SYNC_INTERVAL_KEY = "syncIntervalSeconds";

type SyncMode = "manual" | "polling" | "webhook";

interface ModeOption {
  value: SyncMode;
  label: string;
  description: string;
}

function buildModeOptions(
  delivery: string,
  pollingSupported?: boolean,
): ModeOption[] {
  const options: ModeOption[] = [];

  if (delivery === "webhook" || pollingSupported) {
    if (delivery === "webhook") {
      options.push({
        value: "webhook",
        label: "Real-time (webhook)",
        description:
          "Events are pushed in real time. Fastest option; requires a reachable endpoint.",
      });
    }
    if (pollingSupported) {
      options.push({
        value: "polling",
        label: "Scheduled polling",
        description: "Oxagen polls the source on a defined interval.",
      });
    }
  } else if (delivery === "polling") {
    options.push({
      value: "polling",
      label: "Scheduled polling",
      description: "Oxagen polls the source on a defined interval.",
    });
  }

  options.push({
    value: "manual",
    label: "Manual only",
    description: "Sync only when you trigger it manually from the dashboard.",
  });

  return options;
}

export function SyncCadencePanel() {
  const { schema, formState, setFieldValue } = useConnectorSchema();

  // Hook must be declared unconditionally before any early returns
  const [intervalError, setIntervalError] = React.useState<string | null>(null);

  const sync = schema?.sync;
  if (!sync) return null;

  const modeOptions = buildModeOptions(
    sync.delivery,
    sync.pollingSupported ?? false,
  );
  // Only show panel if there are 2+ options (otherwise no choice to make)
  if (modeOptions.length < 2) return null;

  const defaultMode: SyncMode =
    sync.delivery === "webhook"
      ? "webhook"
      : sync.pollingSupported
        ? "polling"
        : "manual";

  const selectedMode: SyncMode =
    (formState.values[SYNC_MODE_KEY] as SyncMode | undefined) ?? defaultMode;

  const intervalSeconds: number =
    typeof formState.values[SYNC_INTERVAL_KEY] === "number"
      ? (formState.values[SYNC_INTERVAL_KEY] as number)
      : (sync.polling?.defaultIntervalSeconds ?? 300);

  const minInterval = sync.polling?.minIntervalSeconds ?? 60;
  const maxInterval =
    (sync.polling as { maxIntervalSeconds?: number } | undefined)
      ?.maxIntervalSeconds ?? 86400;

  const handleIntervalChange = (val: string) => {
    const n = parseInt(val, 10);
    if (isNaN(n)) {
      setIntervalError("Must be a number");
      return;
    }
    if (n < minInterval) {
      setIntervalError(`Minimum is ${minInterval}s`);
    } else if (n > maxInterval) {
      setIntervalError(`Maximum is ${maxInterval}s`);
    } else {
      setIntervalError(null);
    }
    setFieldValue(SYNC_INTERVAL_KEY, n);
  };

  function formatSeconds(s: number): string {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm font-medium text-foreground">Sync cadence</p>

      <RadioGroup
        value={selectedMode}
        onValueChange={(v) => setFieldValue(SYNC_MODE_KEY, v)}
        className="gap-2"
      >
        {modeOptions.map((opt) => (
          <label
            key={opt.value}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
              selectedMode === opt.value
                ? "border-primary bg-primary/5"
                : "border-border/60 hover:border-border hover:bg-muted/20",
            )}
          >
            <Radio value={opt.value} className="mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-foreground">
                {opt.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {opt.description}
              </span>
            </div>
          </label>
        ))}
      </RadioGroup>

      {/* Polling interval input */}
      {selectedMode === "polling" && sync.polling && (
        <div className="flex flex-col gap-1.5 pl-0">
          <Label htmlFor="sync-interval">Polling interval</Label>
          <div className="flex items-center gap-2">
            <Input
              id="sync-interval"
              type="number"
              value={intervalSeconds}
              onChange={(e) => handleIntervalChange(e.currentTarget.value)}
              min={minInterval}
              max={maxInterval}
              className="w-32"
              aria-invalid={Boolean(intervalError)}
            />
            <span className="text-sm text-muted-foreground">
              seconds ({formatSeconds(intervalSeconds)})
            </span>
          </div>
          {intervalError ? (
            <p role="alert" className="text-xs text-destructive">
              {intervalError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Min: {formatSeconds(minInterval)} — Max:{" "}
              {formatSeconds(maxInterval)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
