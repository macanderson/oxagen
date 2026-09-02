"use client";

import * as React from "react";
import { Save } from "lucide-react";
import type { OrgBillingSettings, PaymentMethodView } from "@oxagen/billing";
import { Panel } from "@/components/ui/panel";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { updateAutoReloadAction } from "@/app/[orgSlug]/billing/actions";
import { useRegisterFillableForm } from "@/lib/page-context";
import type { FieldDescriptor } from "@/lib/ask/fill-types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function centsToDisplayDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parseDollarsToCents(value: string): number | null {
  const n = parseFloat(value);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// ── AutoReloadSettings ────────────────────────────────────────────────────────

export interface AutoReloadSettingsProps {
  orgSlug: string;
  settings: OrgBillingSettings;
  methods: PaymentMethodView[];
  canManage: boolean;
  hasActiveSubscription?: boolean;
}

export function AutoReloadSettings({
  orgSlug,
  settings,
  methods,
  canManage,
  hasActiveSubscription = true,
}: AutoReloadSettingsProps) {
  const toast = useToast();

  const [enabled, setEnabled] = React.useState(settings.autoReloadEnabled);
  const [threshold, setThreshold] = React.useState(
    centsToDisplayDollars(settings.autoReloadThresholdCents),
  );
  const [amount, setAmount] = React.useState(
    centsToDisplayDollars(settings.autoReloadAmountCents),
  );
  const [paymentMethodId, setPaymentMethodId] = React.useState<
    string | undefined
  >(
    settings.autoReloadPaymentMethodId ??
      methods.find((m) => m.isDefault)?.stripePaymentMethodId ??
      methods[0]?.stripePaymentMethodId ??
      undefined,
  );
  const [saving, setSaving] = React.useState(false);

  // ── Fill registration ─────────────────────────────────────────────────────

  const autoReloadFields = React.useMemo<FieldDescriptor[]>(
    () => [
      {
        name: "enabled",
        label: "Enable automatic reload",
        type: "boolean",
        current: enabled,
        required: false,
      },
      {
        name: "threshold",
        label: "Reload threshold ($)",
        type: "number",
        current: threshold,
        required: false,
      },
      {
        name: "amount",
        label: "Reload amount ($)",
        type: "number",
        current: amount,
        required: false,
      },
    ],
    [enabled, threshold, amount],
  );

  const applyAutoReload = React.useCallback(
    (proposed: Record<string, unknown>) => {
      if (typeof proposed.enabled === "boolean") setEnabled(proposed.enabled);
      if (
        typeof proposed.threshold === "string" ||
        typeof proposed.threshold === "number"
      ) {
        setThreshold(String(proposed.threshold));
      }
      if (
        typeof proposed.amount === "string" ||
        typeof proposed.amount === "number"
      ) {
        setAmount(String(proposed.amount));
      }
    },
    [],
  );

  useRegisterFillableForm({
    formId: `billing-auto-reload-${orgSlug}`,
    title: "Automatic reload settings",
    fields: autoReloadFields,
    apply: applyAutoReload,
  });

  const disabled = !canManage;
  const noSubscription = !hasActiveSubscription;
  const toggleDisabled = disabled || noSubscription;
  const inputsDisabled = disabled || !enabled;

  async function handleSave() {
    if (enabled && !hasActiveSubscription) {
      toast.add({
        title: "Subscription required",
        description:
          "You must have an active subscription to enable automatic reload.",
        type: "error",
      });
      setEnabled(false);
      return;
    }

    const thresholdCents = parseDollarsToCents(threshold);
    const amountCents = parseDollarsToCents(amount);

    if (thresholdCents === null) {
      toast.add({
        title: "Invalid threshold",
        description: "Enter a valid dollar amount.",
        type: "error",
      });
      return;
    }
    if (amountCents === null || amountCents < 100) {
      toast.add({
        title: "Invalid reload amount",
        description: "Reload amount must be at least $1.00.",
        type: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const result = await updateAutoReloadAction({
        orgSlug,
        enabled,
        thresholdCents,
        amountCents,
        paymentMethodId: paymentMethodId ?? undefined,
      });
      if ("error" in result && result.error) {
        toast.add({
          title: "Save failed",
          description: result.error,
          type: "error",
        });
      } else {
        toast.add({ title: "Auto-reload settings saved", type: "success" });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="Automatic reload">
      <div className="flex flex-col gap-5">
        {/* Enable toggle */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="autoreload-switch" className="text-sm font-medium">
              Enable automatic reload
            </Label>
            <p className="text-xs text-muted-foreground">
              Automatically buy credits when your balance runs low.
            </p>
            {noSubscription && (
              <p className="text-xs text-destructive">
                Active subscription required to enable automatic reload.
              </p>
            )}
          </div>
          <Switch
            id="autoreload-switch"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={toggleDisabled}
          />
        </div>

        {/* Settings grid — only visible when enabled */}
        {enabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Threshold */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="autoreload-threshold">
                Reload when balance falls below ($)
              </Label>
              <Input
                id="autoreload-threshold"
                type="number"
                min="0"
                step="0.01"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                disabled={inputsDisabled}
                placeholder="5.00"
              />
            </div>

            {/* Amount */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="autoreload-amount">
                Buy this many credits ($)
              </Label>
              <Input
                id="autoreload-amount"
                type="number"
                min="1"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={inputsDisabled}
                placeholder="20.00"
              />
            </div>

            {/* Card selector */}
            {methods.length > 0 && (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="autoreload-card">Charge card</Label>
                <Select
                  value={paymentMethodId}
                  onValueChange={(val) => setPaymentMethodId(val ?? undefined)}
                  disabled={inputsDisabled}
                >
                  <SelectTrigger id="autoreload-card" size="default">
                    <SelectValue>
                      {paymentMethodId
                        ? (() => {
                            const selected = methods.find(
                              (m) =>
                                m.stripePaymentMethodId === paymentMethodId,
                            );
                            if (!selected) return "Select a card";
                            const brand = selected.brand
                              ? selected.brand.charAt(0).toUpperCase() +
                                selected.brand.slice(1).toLowerCase()
                              : "Card";
                            return `${brand} •• ${selected.last4 ?? ""}${selected.isDefault ? " (default)" : ""}`;
                          })()
                        : "Select a card"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {methods.map((m) => (
                      <SelectItem
                        key={m.stripePaymentMethodId}
                        value={m.stripePaymentMethodId}
                      >
                        {m.brand
                          ? m.brand.charAt(0).toUpperCase() +
                            m.brand.slice(1).toLowerCase()
                          : "Card"}{" "}
                        {m.last4 ? `•• ${m.last4}` : ""}
                        {m.isDefault ? " (default)" : ""}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            )}
          </div>
        )}

        {/* Helper copy */}
        {enabled && (
          <p className="text-xs text-muted-foreground">
            When your balance falls below $
            {parseFloat(threshold || "0").toFixed(2)}, we&apos;ll automatically
            buy ${parseFloat(amount || "0").toFixed(2)} in credits.
          </p>
        )}

        {/* Save */}
        {canManage && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="gradient"
              startIcon={<Save className="h-3.5 w-3.5" />}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
