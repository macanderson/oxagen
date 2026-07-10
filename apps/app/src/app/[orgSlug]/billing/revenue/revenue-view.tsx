"use client";

/**
 * RevenueView — the interactive "Stripe for agents" reseller surface. Renders the
 * customer accounts table (with current-period usage + projected revenue),
 * price plans, attribution rules, a per-customer re-bill preview with push-to-
 * Stripe, and run history. Every mutation goes through a server action (invoke())
 * and refreshes the server-fetched data on success.
 *
 * Entities are always cited by human label (customer/plan name, rule label) —
 * never a raw id.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  ResellerCustomer,
  ResellerPricePlan,
  ResellerAttributionRule,
  ResellerRebillRun,
  ResellerRebillPreview,
} from "@oxagen/oxagen/contracts/reseller-shared";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardPanel,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import {
  createCustomerAction,
  updateCustomerAction,
  archiveCustomerAction,
  createPricePlanAction,
  updatePricePlanAction,
  saveAttributionRuleAction,
  deleteAttributionRuleAction,
  pushRebillAction,
  configureStripeAction,
} from "./actions";

// ── Formatting ───────────────────────────────────────────────────────────────

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function planRate(plan: ResellerPricePlan): string {
  if (plan.pricingMode === "markup") {
    const pct = (plan.markupBps ?? 0) / 100;
    return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}% markup`;
  }
  return `${fmtUsd(plan.unitPriceCents ?? 0)}/unit`;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface StripeStatus {
  connected: boolean;
  accountLabel: string | null;
  keyLast4: string | null;
  updatedAt: string | null;
}

interface RevenueViewProps {
  orgSlug: string;
  period: { start: string; end: string; label: string };
  customers: ResellerCustomer[];
  plans: ResellerPricePlan[];
  rules: ResellerAttributionRule[];
  stripe: StripeStatus;
  runs: ResellerRebillRun[];
  previews: ResellerRebillPreview[];
  unattributedCostCents: number;
}

export function RevenueView(props: RevenueViewProps) {
  const { orgSlug, period, customers, plans, rules, stripe, runs, previews } =
    props;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());

  const previewByCustomer = new Map(previews.map((p) => [p.customerId, p]));

  return (
    <div className="flex flex-col gap-6" data-testid="revenue-view">
      <PageHeader
        title="Revenue"
        description="Meter agent usage per end-customer, price it, and push invoices to your Stripe account."
      />

      <StripeConnectCard orgSlug={orgSlug} stripe={stripe} onDone={refresh} />

      <CustomersCard
        orgSlug={orgSlug}
        customers={customers}
        plans={plans}
        previewByCustomer={previewByCustomer}
        period={period}
        stripeConnected={stripe.connected}
        onDone={refresh}
        busy={isPending}
      />

      <PricePlansCard orgSlug={orgSlug} plans={plans} onDone={refresh} />

      <AttributionRulesCard
        orgSlug={orgSlug}
        rules={rules}
        customers={customers}
        onDone={refresh}
      />

      <RunHistoryCard runs={runs} />
    </div>
  );
}

// ── Stripe connection ────────────────────────────────────────────────────────

function StripeConnectCard({
  orgSlug,
  stripe,
  onDone,
}: {
  orgSlug: string;
  stripe: StripeStatus;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [secretKey, setSecretKey] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await configureStripeAction(orgSlug, {
        secretKey,
        accountLabel: accountLabel || null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSecretKey("");
      setOpen(false);
      onDone();
    });
  };

  return (
    <Card data-testid="stripe-connect-card">
      <CardHeader>
        <CardTitle>Stripe account</CardTitle>
        <CardDescription>
          Re-bills are pushed as invoices to your own Stripe account, never the
          platform&apos;s.
        </CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-3">
        {stripe.connected ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge variant="success" data-testid="stripe-connected">
              Connected
            </Badge>
            <span className="text-muted-foreground">
              {stripe.accountLabel ? `${stripe.accountLabel} · ` : ""}
              key ending ····{stripe.keyLast4}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen((v) => !v)}
            >
              Replace key
            </Button>
          </div>
        ) : (
          <Alert data-testid="stripe-not-connected">
            Connect your Stripe account to push customer invoices.{" "}
            <Button variant="link" size="sm" onClick={() => setOpen(true)}>
              Connect now
            </Button>
          </Alert>
        )}

        {open ? (
          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="stripe-secret">Stripe secret key</Label>
              <Input
                id="stripe-secret"
                type="password"
                placeholder="sk_live_… or sk_test_…"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                data-testid="stripe-secret-input"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="stripe-label">Account label (optional)</Label>
              <Input
                id="stripe-label"
                placeholder="Acme reseller account"
                value={accountLabel}
                onChange={(e) => setAccountLabel(e.target.value)}
              />
            </div>
            {error ? <p className="text-xs text-error">{error}</p> : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={submit}
                disabled={pending || secretKey.length < 12}
                data-testid="stripe-save"
              >
                {pending ? "Saving…" : "Save key"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </CardPanel>
    </Card>
  );
}

// ── Customers ────────────────────────────────────────────────────────────────

interface CustomerFormState {
  id?: string;
  name: string;
  externalRef: string;
  pricePlanId: string;
}

const EMPTY_CUSTOMER: CustomerFormState = {
  name: "",
  externalRef: "",
  pricePlanId: "",
};

function CustomersCard({
  orgSlug,
  customers,
  plans,
  previewByCustomer,
  period,
  stripeConnected,
  onDone,
}: {
  orgSlug: string;
  customers: ResellerCustomer[];
  plans: ResellerPricePlan[];
  previewByCustomer: Map<string, ResellerRebillPreview>;
  period: { start: string; end: string; label: string };
  stripeConnected: boolean;
  onDone: () => void;
  busy: boolean;
}) {
  const [form, setForm] = useState<CustomerFormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [pushState, setPushState] = useState<
    Record<
      string,
      { status: "pushed" | "failed"; message: string; url?: string | null }
    >
  >({});

  const openCreate = () => {
    setError(null);
    setForm({ ...EMPTY_CUSTOMER });
  };
  const openEdit = (c: ResellerCustomer) => {
    setError(null);
    setForm({
      id: c.id,
      name: c.name,
      externalRef: c.externalRef ?? "",
      pricePlanId: c.pricePlanId ?? "",
    });
  };

  const save = () => {
    if (!form) return;
    setError(null);
    startTransition(async () => {
      const payload = {
        name: form.name,
        externalRef: form.externalRef || null,
        pricePlanId: form.pricePlanId || null,
      };
      const res = form.id
        ? await updateCustomerAction(orgSlug, { id: form.id, ...payload })
        : await createCustomerAction(orgSlug, payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setForm(null);
      onDone();
    });
  };

  const archive = (id: string) => {
    startTransition(async () => {
      const res = await archiveCustomerAction(orgSlug, id);
      if (!res.ok) setError(res.error);
      else onDone();
    });
  };

  const togglePause = (c: ResellerCustomer) => {
    startTransition(async () => {
      const res = await updateCustomerAction(orgSlug, {
        id: c.id,
        status: c.status === "active" ? "paused" : "active",
      });
      if (!res.ok) setError(res.error);
      else onDone();
    });
  };

  const push = (customerId: string) => {
    setPushState((s) => {
      const next = { ...s };
      delete next[customerId];
      return next;
    });
    startTransition(async () => {
      const res = await pushRebillAction(orgSlug, {
        customerId,
        start: period.start,
        end: period.end,
      });
      if (!res.ok) {
        setPushState((s) => ({
          ...s,
          [customerId]: { status: "failed", message: res.error },
        }));
        return;
      }
      if (res.needsStripeConnection) {
        setPushState((s) => ({
          ...s,
          [customerId]: {
            status: "failed",
            message: "Connect your Stripe account first.",
          },
        }));
        return;
      }
      const run = res.run;
      setPushState((s) => ({
        ...s,
        [customerId]:
          run.status === "pushed"
            ? {
                status: "pushed",
                message: `Invoiced ${fmtUsd(run.totalCents)}`,
                url: run.hostedInvoiceUrl,
              }
            : { status: "failed", message: run.error ?? "Push failed" },
      }));
      onDone();
    });
  };

  return (
    <Card data-testid="customers-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Customer accounts</CardTitle>
          <CardDescription>
            The customers you bill. Usage and projected revenue are for{" "}
            {period.label}.
          </CardDescription>
        </div>
        <Button size="sm" onClick={openCreate} data-testid="add-customer">
          Add customer
        </Button>
      </CardHeader>
      <CardPanel className="flex flex-col gap-3">
        {form ? (
          <div
            className="flex flex-col gap-3 rounded-md border border-border p-3"
            data-testid="customer-form"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="cust-name">Name</Label>
                <Input
                  id="cust-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Acme Corp"
                  data-testid="customer-name-input"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="cust-ref">External ref (optional)</Label>
                <Input
                  id="cust-ref"
                  value={form.externalRef}
                  onChange={(e) =>
                    setForm({ ...form, externalRef: e.target.value })
                  }
                  placeholder="crm-1234"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="cust-plan">Price plan</Label>
                <Select
                  value={form.pricePlanId || "none"}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      pricePlanId: v === "none" ? "" : (v ?? ""),
                    })
                  }
                >
                  <SelectTrigger id="cust-plan" size="sm">
                    <SelectValue placeholder="No plan" />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="none">No plan</SelectItem>
                    {plans.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            {error ? <p className="text-xs text-error">{error}</p> : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={save}
                disabled={pending || !form.name}
                data-testid="customer-save"
              >
                {pending
                  ? "Saving…"
                  : form.id
                    ? "Save changes"
                    : "Create customer"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {customers.length === 0 && !form ? (
          <div
            className="py-8 text-center text-sm text-muted-foreground"
            data-testid="customers-empty"
          >
            No customer accounts yet — add your first customer.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Usage cost</TableHead>
                <TableHead className="text-right">Projected revenue</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((c) => {
                const preview = previewByCustomer.get(c.id);
                const ps = pushState[c.id];
                return (
                  <TableRow key={c.id} data-testid="customer-row">
                    <TableCell>
                      <div className="font-medium text-foreground">
                        {c.name}
                      </div>
                      {c.externalRef ? (
                        <div className="text-xs text-muted-foreground">
                          {c.externalRef}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {c.pricePlanName ?? (
                        <span className="text-xs text-muted-foreground">
                          No plan
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {preview ? fmtUsd(preview.subtotalCents) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {preview ? fmtUsd(preview.totalCents) : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={c.status === "active" ? "success" : "muted"}
                      >
                        {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => push(c.id)}
                            disabled={
                              pending || c.status !== "active" || !c.pricePlanId
                            }
                            title={
                              !c.pricePlanId
                                ? "Assign a price plan first"
                                : !stripeConnected
                                  ? "Connect Stripe first"
                                  : "Push this customer's invoice to Stripe"
                            }
                            data-testid="push-customer"
                          >
                            Push
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEdit(c)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => togglePause(c)}
                          >
                            {c.status === "active" ? "Pause" : "Resume"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => archive(c.id)}
                          >
                            Archive
                          </Button>
                        </div>
                        {ps ? (
                          <div className="text-xs" data-testid="push-result">
                            {ps.status === "pushed" ? (
                              <span className="text-success">
                                {ps.message}
                                {ps.url ? (
                                  <>
                                    {" · "}
                                    <a
                                      className="underline"
                                      href={ps.url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      View invoice
                                    </a>
                                  </>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-error">
                                {ps.message}{" "}
                                <button
                                  className="underline"
                                  onClick={() => push(c.id)}
                                  type="button"
                                >
                                  Retry
                                </button>
                              </span>
                            )}
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardPanel>
    </Card>
  );
}

// ── Price plans ──────────────────────────────────────────────────────────────

interface PlanFormState {
  id?: string;
  name: string;
  pricingMode: "markup" | "per_unit";
  markupPct: string;
  unitPriceDollars: string;
}

const EMPTY_PLAN: PlanFormState = {
  name: "",
  pricingMode: "markup",
  markupPct: "20",
  unitPriceDollars: "0.01",
};

function PricePlansCard({
  orgSlug,
  plans,
  onDone,
}: {
  orgSlug: string;
  plans: ResellerPricePlan[];
  onDone: () => void;
}) {
  const [form, setForm] = useState<PlanFormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    if (!form) return;
    setError(null);
    startTransition(async () => {
      const base = {
        name: form.name,
        pricingMode: form.pricingMode,
        markupBps:
          form.pricingMode === "markup"
            ? Math.round(Number(form.markupPct) * 100)
            : null,
        unitPriceCents:
          form.pricingMode === "per_unit"
            ? Math.round(Number(form.unitPriceDollars) * 100)
            : null,
      };
      const res = form.id
        ? await updatePricePlanAction(orgSlug, { id: form.id, ...base })
        : await createPricePlanAction(orgSlug, base);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setForm(null);
      onDone();
    });
  };

  return (
    <Card data-testid="price-plans-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Price plans</CardTitle>
          <CardDescription>
            Markup over raw metered cost, or a flat price per metered unit.
          </CardDescription>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setError(null);
            setForm({ ...EMPTY_PLAN });
          }}
          data-testid="add-plan"
        >
          Add plan
        </Button>
      </CardHeader>
      <CardPanel className="flex flex-col gap-3">
        {form ? (
          <div
            className="flex flex-col gap-3 rounded-md border border-border p-3"
            data-testid="plan-form"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="plan-name">Name</Label>
                <Input
                  id="plan-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Standard markup"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="plan-mode">Mode</Label>
                <Select
                  value={form.pricingMode}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      pricingMode: (v as "markup" | "per_unit") ?? "markup",
                    })
                  }
                >
                  <SelectTrigger id="plan-mode" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="markup">Markup %</SelectItem>
                    <SelectItem value="per_unit">Per unit</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                {form.pricingMode === "markup" ? (
                  <>
                    <Label htmlFor="plan-markup">Markup %</Label>
                    <Input
                      id="plan-markup"
                      type="number"
                      value={form.markupPct}
                      onChange={(e) =>
                        setForm({ ...form, markupPct: e.target.value })
                      }
                    />
                  </>
                ) : (
                  <>
                    <Label htmlFor="plan-unit">Price per unit ($)</Label>
                    <Input
                      id="plan-unit"
                      type="number"
                      step="0.01"
                      value={form.unitPriceDollars}
                      onChange={(e) =>
                        setForm({ ...form, unitPriceDollars: e.target.value })
                      }
                    />
                  </>
                )}
              </div>
            </div>
            {error ? <p className="text-xs text-error">{error}</p> : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={save}
                disabled={pending || !form.name}
                data-testid="plan-save"
              >
                {pending ? "Saving…" : form.id ? "Save changes" : "Create plan"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {plans.length === 0 && !form ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No price plans yet — add one to price customer usage.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium text-foreground">
                    {p.name}
                  </TableCell>
                  <TableCell>{planRate(p)}</TableCell>
                  <TableCell className="uppercase">{p.currency}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setForm({
                          id: p.id,
                          name: p.name,
                          pricingMode: p.pricingMode,
                          markupPct: String((p.markupBps ?? 0) / 100),
                          unitPriceDollars: String(
                            (p.unitPriceCents ?? 0) / 100,
                          ),
                        });
                      }}
                    >
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardPanel>
    </Card>
  );
}

// ── Attribution rules ────────────────────────────────────────────────────────

interface RuleFormState {
  id?: string;
  matchKind: "workspace" | "principal" | "capability";
  matchValue: string;
  matchLabel: string;
  customerId: string;
  priority: string;
}

function AttributionRulesCard({
  orgSlug,
  rules,
  customers,
  onDone,
}: {
  orgSlug: string;
  rules: ResellerAttributionRule[];
  customers: ResellerCustomer[];
  onDone: () => void;
}) {
  const [form, setForm] = useState<RuleFormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    if (!form) return;
    setError(null);
    startTransition(async () => {
      const res = await saveAttributionRuleAction(orgSlug, {
        id: form.id,
        matchKind: form.matchKind,
        matchValue: form.matchValue,
        matchLabel: form.matchLabel || form.matchValue,
        customerId: form.customerId,
        priority: Number(form.priority) || 100,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setForm(null);
      onDone();
    });
  };

  const remove = (id: string) => {
    startTransition(async () => {
      const res = await deleteAttributionRuleAction(orgSlug, id);
      if (!res.ok) setError(res.error);
      else onDone();
    });
  };

  const canAdd = customers.length > 0;

  return (
    <Card data-testid="rules-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Attribution rules</CardTitle>
          <CardDescription>
            Map observed usage (by workspace, principal, or capability) to a
            customer. Lower priority runs first; the first match wins.
          </CardDescription>
        </div>
        <Button
          size="sm"
          disabled={!canAdd}
          onClick={() => {
            setError(null);
            setForm({
              matchKind: "workspace",
              matchValue: "",
              matchLabel: "",
              customerId: customers[0]?.id ?? "",
              priority: "100",
            });
          }}
          data-testid="add-rule"
        >
          Add rule
        </Button>
      </CardHeader>
      <CardPanel className="flex flex-col gap-3">
        {!canAdd ? (
          <p className="text-xs text-muted-foreground">
            Add a customer before creating rules.
          </p>
        ) : null}

        {form ? (
          <div
            className="flex flex-col gap-3 rounded-md border border-border p-3"
            data-testid="rule-form"
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="flex flex-col gap-1">
                <Label htmlFor="rule-kind">Match on</Label>
                <Select
                  value={form.matchKind}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      matchKind:
                        (v as RuleFormState["matchKind"]) ?? "workspace",
                    })
                  }
                >
                  <SelectTrigger id="rule-kind" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="workspace">Workspace</SelectItem>
                    <SelectItem value="principal">Principal</SelectItem>
                    <SelectItem value="capability">Capability</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rule-value">Match value</Label>
                <Input
                  id="rule-value"
                  value={form.matchValue}
                  onChange={(e) =>
                    setForm({ ...form, matchValue: e.target.value })
                  }
                  placeholder="workspace id / principal id / capability name"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rule-label">Label</Label>
                <Input
                  id="rule-label"
                  value={form.matchLabel}
                  onChange={(e) =>
                    setForm({ ...form, matchLabel: e.target.value })
                  }
                  placeholder="Marketing workspace"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rule-customer">Customer</Label>
                <Select
                  value={form.customerId}
                  onValueChange={(v) =>
                    setForm({ ...form, customerId: v ?? "" })
                  }
                >
                  <SelectTrigger id="rule-customer" size="sm">
                    <SelectValue placeholder="Customer" />
                  </SelectTrigger>
                  <SelectPopup>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rule-priority">Priority</Label>
                <Input
                  id="rule-priority"
                  type="number"
                  value={form.priority}
                  onChange={(e) =>
                    setForm({ ...form, priority: e.target.value })
                  }
                />
              </div>
            </div>
            {error ? <p className="text-xs text-error">{error}</p> : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={save}
                disabled={pending || !form.matchValue || !form.customerId}
                data-testid="rule-save"
              >
                {pending ? "Saving…" : form.id ? "Save changes" : "Create rule"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {rules.length === 0 && !form ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No attribution rules yet — usage will be unattributed until you add
            one.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Match</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Priority</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium text-foreground">
                    {r.matchLabel}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.matchKind}</Badge>
                  </TableCell>
                  <TableCell>{r.customerName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.priority}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setForm({
                          id: r.id,
                          matchKind: r.matchKind,
                          matchValue: r.matchValue,
                          matchLabel: r.matchLabel,
                          customerId: r.customerId,
                          priority: String(r.priority),
                        });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(r.id)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardPanel>
    </Card>
  );
}

// ── Run history ──────────────────────────────────────────────────────────────

function RunHistoryCard({ runs }: { runs: ResellerRebillRun[] }) {
  return (
    <Card data-testid="runs-card">
      <CardHeader>
        <CardTitle>Re-bill history</CardTitle>
        <CardDescription>
          Every push, with its period, billed total, and Stripe invoice.
        </CardDescription>
      </CardHeader>
      <CardPanel>
        {runs.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No re-bills pushed yet.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Billed</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Invoice</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="font-medium text-foreground">
                    {run.customerName}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {run.periodStart.slice(0, 10)} →{" "}
                    {run.periodEnd.slice(0, 10)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtUsd(run.totalCents)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        run.status === "pushed"
                          ? "success"
                          : run.status === "failed"
                            ? "error"
                            : "muted"
                      }
                    >
                      {run.status}
                    </Badge>
                    {run.status === "failed" && run.error ? (
                      <div className="mt-1 text-xs text-error">{run.error}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {run.hostedInvoiceUrl ? (
                      <a
                        className="text-xs underline"
                        href={run.hostedInvoiceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardPanel>
    </Card>
  );
}
