"use client";
import * as React from "react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/components/ui/toast";
import { AlertCircle, CreditCard } from "lucide-react";
import { formatDate, formatCents } from "@/lib/utils";
import { formatRelativeRenewal } from "@/lib/billing-format";
import {
  cancelSubscriptionAction,
  reactivateSubscriptionAction,
  setSeatsAction,
  previewSeatsAction,
} from "@/app/[orgSlug]/billing/actions";
import type { SeatChangePreview } from "@oxagen/billing";

export interface Subscription {
  publicId: string;
  status: string;
  planSlug: string;
  planName: string;
  billingInterval: "month" | "year";
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  seatCount: number;
}

/** Card-on-file display data passed from the server. */
export interface DefaultCard {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  active: "success",
  trialing: "success",
  past_due: "warning",
  unpaid: "warning",
  paused: "warning",
  canceled: "destructive",
  incomplete: "muted",
  incomplete_expired: "muted",
};

// ── SeatControl ───────────────────────────────────────────────────────────────

interface SeatControlProps {
  orgSlug: string;
  currentSeats: number;
  /** Scroll to the payment methods section. */
  onChangeCard?: () => void;
}

function SeatControl({ orgSlug, currentSeats, onChangeCard }: SeatControlProps) {
  const [seats, setSeats] = React.useState(String(currentSeats));
  const [previewPending, startPreviewTransition] = React.useTransition();
  const [confirmPending, startConfirmTransition] = React.useTransition();

  /** null = closed, "loading" = fetching, SeatChangePreview = confirm open, "blocked:..." = error dialog */
  const [dialogState, setDialogState] = React.useState<
    null | "loading" | SeatChangePreview | string
  >(null);

  const { add: addToast } = useToast();

  function handleUpdate() {
    const n = parseInt(seats, 10);
    if (!Number.isInteger(n) || n < 1) {
      addToast({ title: "Invalid seat count", description: "Seats must be at least 1.", type: "error" });
      return;
    }
    if (n === currentSeats) return;

    setDialogState("loading");
    startPreviewTransition(async () => {
      const result = await previewSeatsAction({ orgSlug, seats: n });
      if ("error" in result) {
        setDialogState(null);
        addToast({ title: "Could not preview seat change", description: result.error, type: "error" });
        return;
      }
      if (result.blocked) {
        // Use a string prefix to discriminate the blocked-message branch.
        setDialogState(
          `blocked:You have members occupying ${result.blocked.used} of ${result.blocked.licenses} licensed seats. Remove members before reducing.`,
        );
        return;
      }
      setDialogState(result);
    });
  }

  function handleConfirm() {
    const n = parseInt(seats, 10);
    startConfirmTransition(async () => {
      const res = await setSeatsAction({ orgSlug, seats: n });
      if (res.ok) {
        addToast({ title: "Seats updated", description: `Seat count updated to ${n}.`, type: "success" });
        setDialogState(null);
      } else if (res.code === "seat_limit_reached") {
        setDialogState(
          `blocked:You have ${res.used} member${res.used === 1 ? "" : "s"} — you can't drop below ${res.used} license${res.used === 1 ? "" : "s"}. Remove members first.`,
        );
      } else {
        addToast({ title: "Failed to update seats", description: res.error, type: "error" });
        setDialogState(null);
      }
    });
  }

  const isDialogOpen = dialogState !== null && dialogState !== "loading";
  // A blocked-message is stored as "blocked:<human text>" string to avoid
  // union narrowing ambiguity with SeatChangePreview (which also has a `blocked` field).
  const blockedMessage =
    typeof dialogState === "string" && dialogState.startsWith("blocked:")
      ? dialogState.slice("blocked:".length)
      : null;
  const preview =
    typeof dialogState === "object" && dialogState !== null
      ? (dialogState as SeatChangePreview)
      : null;

  return (
    <>
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Seats</span>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              value={seats}
              onChange={(e) => setSeats(e.target.value)}
              className="w-20"
              size="sm"
              disabled={previewPending || confirmPending || dialogState === "loading"}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleUpdate}
              disabled={previewPending || confirmPending || dialogState === "loading" || seats === String(currentSeats)}
            >
              {previewPending || dialogState === "loading" ? "Loading…" : "Update"}
            </Button>
          </div>
        </div>
      </div>

      {/* Seat-change confirmation dialog */}
      <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) setDialogState(null); }}>
        <DialogPopup>
          {blockedMessage ? (
            <>
              <DialogHeader>
                <DialogTitle>Cannot reduce seats</DialogTitle>
                <DialogDescription>You have more members than the requested seat count.</DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Alert variant="error">
                  <AlertCircle />
                  <AlertTitle>Seat limit conflict</AlertTitle>
                  <AlertDescription>{blockedMessage}</AlertDescription>
                </Alert>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="default" />}>OK</DialogClose>
              </DialogFooter>
            </>
          ) : preview ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {preview.direction === "increase" ? "Adding seats" : "Removing seats"}
                </DialogTitle>
                <DialogDescription>
                  Review the change before confirming.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="space-y-2 text-sm">
                  {preview.isCharge ? (
                    <p>
                      Adding{" "}
                      <strong>{preview.requestedSeats - preview.currentSeats} seat{preview.requestedSeats - preview.currentSeats === 1 ? "" : "s"}</strong>{" "}
                      will charge{" "}
                      <strong>{formatCents(preview.amountCents)}</strong> now to{" "}
                      {preview.card
                        ? <strong>{preview.card.brand} ••{preview.card.last4}</strong>
                        : "your card on file"
                      }.
                    </p>
                  ) : preview.isCredit ? (
                    <p>
                      Removing{" "}
                      <strong>{preview.currentSeats - preview.requestedSeats} seat{preview.currentSeats - preview.requestedSeats === 1 ? "" : "s"}</strong>{" "}
                      will credit{" "}
                      <strong>{formatCents(preview.amountCents)}</strong> to your next invoice.
                    </p>
                  ) : (
                    <p>No charge for this change.</p>
                  )}
                </div>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                {preview.isCharge ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDialogState(null);
                      if (onChangeCard) {
                        onChangeCard();
                      } else {
                        document.getElementById("payment-methods")?.scrollIntoView({ behavior: "smooth" });
                      }
                    }}
                  >
                    Change card
                  </Button>
                ) : null}
                <Button onClick={handleConfirm} disabled={confirmPending}>
                  {confirmPending
                    ? "Processing…"
                    : preview.isCharge
                      ? "Confirm & pay"
                      : "Confirm"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}

// ── CancelDialog / ReactivateDialog ──────────────────────────────────────────

function CancelDialog({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const { add: addToast } = useToast();

  function handleCancel() {
    startTransition(async () => {
      const res = await cancelSubscriptionAction({ orgSlug });
      if (res.ok) {
        addToast({ title: "Subscription cancelled", description: "Access continues until the period ends.", type: "success" });
        setOpen(false);
      } else {
        addToast({ title: "Cancellation failed", description: res.error, type: "error" });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        Cancel subscription
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Cancel subscription?</DialogTitle>
          <DialogDescription>
            Your plan will remain active until the end of the current billing period. You can reactivate before then.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Keep subscription</DialogClose>
          <Button variant="destructive" onClick={handleCancel} disabled={pending}>
            {pending ? "Cancelling…" : "Yes, cancel"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ReactivateDialog({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const { add: addToast } = useToast();

  function handleReactivate() {
    startTransition(async () => {
      const res = await reactivateSubscriptionAction({ orgSlug });
      if (res.ok) {
        addToast({ title: "Subscription reactivated", description: "Cancellation has been reversed.", type: "success" });
        setOpen(false);
      } else {
        addToast({ title: "Reactivation failed", description: res.error, type: "error" });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="default" size="sm" />}>
        Reactivate subscription
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Reactivate subscription?</DialogTitle>
          <DialogDescription>
            This will undo the scheduled cancellation. You will continue to be billed as normal.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Never mind</DialogClose>
          <Button onClick={handleReactivate} disabled={pending}>
            {pending ? "Reactivating…" : "Yes, reactivate"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── SubscriptionSummary ───────────────────────────────────────────────────────

export interface SubscriptionSummaryProps {
  subscription: Subscription | null;
  orgSlug: string;
  /** Only owner/admin/billing can see plan/seat controls. */
  canManageBilling: boolean;
  /** Default card on file — passed from the server. */
  defaultCard?: DefaultCard | null;
  /** Called when the user clicks "Change card" inside the seat confirm dialog. */
  onChangeCard?: () => void;
}

export function SubscriptionSummary({
  subscription,
  orgSlug,
  canManageBilling,
  defaultCard,
  onChangeCard,
}: SubscriptionSummaryProps) {
  if (!subscription) {
    // No paid subscription ⇒ the org is on the Free plan (the baseline tier),
    // not "nothing". Present it as the current plan so the billing page always
    // reflects an active tier.
    return (
      <Panel title={<span className="flex items-center gap-2">Current plan<Badge variant="muted">Free</Badge></span>}>
          <p className="text-sm text-muted-foreground">
            You&rsquo;re on the <span className="font-medium text-foreground">Free</span> plan.
            Upgrade below for more credits, seats, and capabilities.
          </p>
      </Panel>
    );
  }

  const renewalLabel = formatRelativeRenewal(subscription.currentPeriodEnd, {
    cancel: subscription.cancelAtPeriodEnd,
  });

  return (
    <Panel title={<span className="flex items-center gap-2">Current subscription<Badge variant={STATUS_VARIANT[subscription.status] ?? "muted"}>{subscription.status}</Badge>{subscription.cancelAtPeriodEnd ? <Badge variant="warning">Cancels at period end</Badge> : null}</span>}>
        {/* Prominent, plain-language renewal statement (exact date always shown). */}
        <p className="mb-4 text-sm" data-testid="renewal-statement">
          Your <span className="font-medium" data-testid="plan-name">{subscription.planName}</span>{" "}
          plan {renewalLabel}.
        </p>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-muted-foreground">Billing</dt>
            <dd className="font-medium capitalize">{subscription.billingInterval}ly</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Current seats</dt>
            <dd className="font-medium">{subscription.seatCount}</dd>
          </div>
        </dl>

        {/* Card on file */}
        {defaultCard ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <CreditCard className="h-4 w-4" />
            <span>
              <span className="capitalize">{defaultCard.brand}</span> ••{defaultCard.last4} · expires{" "}
              {String(defaultCard.expMonth).padStart(2, "0")}/{String(defaultCard.expYear).slice(-2)}
            </span>
          </div>
        ) : null}

        {canManageBilling ? (
          <>
            <Separator className="my-4" />
            <SeatControl
              orgSlug={orgSlug}
              currentSeats={subscription.seatCount}
              onChangeCard={onChangeCard}
            />
          </>
        ) : null}

        <Separator className="my-4" />
        <p className="text-xs text-muted-foreground">
          Period {formatDate(subscription.currentPeriodStart)} →{" "}
          {formatDate(subscription.currentPeriodEnd)}
        </p>

        {canManageBilling ? (
          <div className="mt-4 flex gap-2">
            {subscription.cancelAtPeriodEnd ? (
              <ReactivateDialog orgSlug={orgSlug} />
            ) : (
              <CancelDialog orgSlug={orgSlug} />
            )}
          </div>
        ) : null}
    </Panel>
  );
}
