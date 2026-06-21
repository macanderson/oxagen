"use client";

/**
 * automation-create-inline-schedule-config.tsx — "Schedule configuration"
 * section rendered when the automation trigger type is "schedule".
 *
 * Owns: cron-expression field, timezone field.
 */

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ── Props ──────────────────────────────────────────────────────────────────────

interface ScheduleTriggerConfigProps {
  cronExpression: string;
  onCronExpressionChange: (value: string) => void;
  cronId: string;

  timezone: string;
  onTimezoneChange: (value: string) => void;
  timezoneId: string;

  disabled: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ScheduleTriggerConfig({
  cronExpression,
  onCronExpressionChange,
  cronId,
  timezone,
  onTimezoneChange,
  timezoneId,
  disabled,
}: ScheduleTriggerConfigProps): React.ReactElement {
  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-muted/30 p-4">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Schedule configuration
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={cronId}>Cron expression</Label>
          <Input
            id={cronId}
            name="cronExpression"
            placeholder="e.g. 0 9 * * 1"
            value={cronExpression}
            onChange={(e) => onCronExpressionChange(e.target.value)}
            disabled={disabled}
            autoComplete="off"
            data-testid="cron-expression-input"
          />
          <p className="text-xs text-muted-foreground">
            POSIX cron — min hr dom mon dow
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={timezoneId}>Timezone</Label>
          <Input
            id={timezoneId}
            name="timezone"
            placeholder="e.g. America/New_York"
            value={timezone}
            onChange={(e) => onTimezoneChange(e.target.value)}
            disabled={disabled}
            autoComplete="off"
            data-testid="timezone-input"
          />
        </div>
      </div>
    </div>
  );
}
