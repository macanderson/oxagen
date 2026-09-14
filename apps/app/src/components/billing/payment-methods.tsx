"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  useStripe,
  useElements,
  PaymentElement,
} from "@stripe/react-stripe-js";
import type { StripePaymentElementOptions } from "@stripe/stripe-js";
import { CreditCard, Star } from "lucide-react";
import type { PaymentMethodView } from "@oxagen/billing";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { StripeElementsProvider } from "./stripe-elements-provider";
import {
  createSetupIntentAction,
  syncPaymentMethodsAction,
  setDefaultPaymentMethodAction,
  removePaymentMethodAction,
} from "@/app/[orgSlug]/billing/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatExpiry(month: number | null, year: number | null): string {
  if (!month || !year) return "";
  return `Expires ${String(month).padStart(2, "0")}/${year}`;
}

function formatBrand(brand: string | null): string {
  if (!brand) return "Card";
  return brand.charAt(0).toUpperCase() + brand.slice(1).toLowerCase();
}

// ── AddCardForm (inside Elements context) ─────────────────────────────────────

interface AddCardFormProps {
  orgSlug: string;
  onSuccess: () => void;
  onCancel: () => void;
}

function AddCardForm({ orgSlug, onSuccess, onCancel }: AddCardFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const toast = useToast();
  const [submitting, setSubmitting] = React.useState(false);

  const paymentElementOptions: StripePaymentElementOptions = {
    layout: "tabs",
  };

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    try {
      const { error } = await stripe.confirmSetup({
        elements,
        confirmParams: {},
        redirect: "if_required",
      });

      if (error) {
        toast.add({
          title: "Card not saved",
          description:
            error.message ?? "Please check your card details and try again.",
          type: "error",
        });
        return;
      }

      // Sync the newly attached card into our DB mirror.
      try {
        await syncPaymentMethodsAction({ orgSlug });
      } catch (syncErr) {
        // The SetupIntent already confirmed in Stripe — the card IS live there.
        // If the DB mirror sync fails, surface it so the user knows and can
        // reload the page to re-trigger the sync rather than assuming success.
        toast.add({
          title: "Card saved in Stripe, but sync failed",
          description:
            "Your card was accepted by Stripe but could not be saved to your account. Please refresh the page. If the card does not appear, contact support.",
          type: "error",
        });
        console.error(
          "[payment-methods] syncPaymentMethodsAction failed after Stripe confirmSetup",
          syncErr,
        );
        return;
      }
      toast.add({ title: "Card saved", type: "success" });
      onSuccess();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <PaymentElement options={paymentElementOptions} />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="gradient"
          disabled={submitting || !stripe || !elements}
        >
          {submitting ? "Saving…" : "Save card"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ── AddCardDialog ─────────────────────────────────────────────────────────────

interface AddCardDialogProps {
  orgSlug: string;
  publishableKey: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  router: ReturnType<typeof useRouter>;
}

function AddCardDialog({
  orgSlug,
  publishableKey,
  open,
  onOpenChange,
  router,
}: AddCardDialogProps) {
  const [clientSecret, setClientSecret] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // Fetch a SetupIntent clientSecret when the dialog opens. Resetting state on
  // close happens in handleOpenChange (an event handler), NOT here — a
  // synchronous setState inside an effect trips the cascading-render lint.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    createSetupIntentAction({ orgSlug }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setClientSecret(result.clientSecret);
      } else {
        setLoadError(result.error ?? "Could not initialise card form.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, orgSlug]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      // Clear the consumed SetupIntent so reopening always fetches a fresh one.
      setClientSecret(null);
      setLoadError(null);
    }
    onOpenChange(next);
  }

  function handleSuccess() {
    handleOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add payment method</DialogTitle>
          <DialogDescription>
            Your card details are tokenised directly with Stripe — they never
            pass through Oxagen servers.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {loadError ? (
            <p className="text-sm text-destructive">{loadError}</p>
          ) : !clientSecret ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <StripeElementsProvider
              publishableKey={publishableKey}
              clientSecret={clientSecret}
            >
              <AddCardForm
                orgSlug={orgSlug}
                onSuccess={handleSuccess}
                onCancel={() => handleOpenChange(false)}
              />
            </StripeElementsProvider>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

// ── PaymentMethodRow ──────────────────────────────────────────────────────────

interface PaymentMethodRowProps {
  method: PaymentMethodView;
  orgSlug: string;
  canManage: boolean;
  onMutate: () => void;
}

function PaymentMethodRow({
  method,
  orgSlug,
  canManage,
  onMutate,
}: PaymentMethodRowProps) {
  const toast = useToast();
  const [removing, setRemoving] = React.useState(false);
  const [settingDefault, setSettingDefault] = React.useState(false);

  async function handleMakeDefault() {
    setSettingDefault(true);
    try {
      const result = await setDefaultPaymentMethodAction({
        orgSlug,
        paymentMethodId: method.stripePaymentMethodId,
      });
      if ("error" in result && result.error) {
        toast.add({
          title: "Failed to set default",
          description: result.error,
          type: "error",
        });
      } else {
        toast.add({ title: "Default card updated", type: "success" });
        onMutate();
      }
    } finally {
      setSettingDefault(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      const result = await removePaymentMethodAction({
        orgSlug,
        paymentMethodId: method.stripePaymentMethodId,
      });
      if ("error" in result && result.error) {
        if (result.code === "last_payment_method") {
          toast.add({
            title: "Cannot remove card",
            description:
              "You can't remove your only payment method while you have an active plan. Add a new card first.",
            type: "warning",
          });
        } else {
          toast.add({
            title: "Remove failed",
            description: result.error,
            type: "error",
          });
        }
      } else {
        toast.add({ title: "Card removed", type: "success" });
        onMutate();
      }
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <CreditCard className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">
            {formatBrand(method.brand)}{" "}
            {method.last4 ? `•• ${method.last4}` : ""}
          </span>
          {(method.expMonth || method.expYear) && (
            <span className="text-xs text-muted-foreground">
              {formatExpiry(method.expMonth, method.expYear)}
            </span>
          )}
        </div>
        {method.isDefault && (
          <Badge variant="outline" size="sm">
            Default
          </Badge>
        )}
      </div>
      {canManage && (
        <div className="flex items-center gap-2">
          {!method.isDefault && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMakeDefault}
              disabled={settingDefault}
              aria-label="Make this card the default payment method"
            >
              <Star className="h-3.5 w-3.5" />
              <span>Make default</span>
            </Button>
          )}
          <Button
            variant="destructive-outline"
            size="sm"
            onClick={handleRemove}
            disabled={removing}
            aria-label="Remove this payment method"
          >
            {removing ? "Removing…" : "Remove"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── PaymentMethods (main export) ──────────────────────────────────────────────

export interface PaymentMethodsProps {
  orgSlug: string;
  methods: PaymentMethodView[];
  publishableKey: string | undefined;
  canManage: boolean;
}

export function PaymentMethods({
  orgSlug,
  methods,
  publishableKey,
  canManage,
}: PaymentMethodsProps) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  function handleMutate() {
    router.refresh();
  }

  return (
    <Panel
      id="payment-methods"
      title="Payment methods"
      actions={
        canManage ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDialogOpen(true)}
            >
              {methods.length === 0 ? "Add card" : "Add / change card"}
            </Button>
            <AddCardDialog
              orgSlug={orgSlug}
              publishableKey={publishableKey}
              open={dialogOpen}
              onOpenChange={setDialogOpen}
              router={router}
            />
          </>
        ) : undefined
      }
    >
      {methods.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No payment method on file.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {methods.map((method) => (
            <PaymentMethodRow
              key={method.stripePaymentMethodId}
              method={method}
              orgSlug={orgSlug}
              canManage={canManage}
              onMutate={handleMutate}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
