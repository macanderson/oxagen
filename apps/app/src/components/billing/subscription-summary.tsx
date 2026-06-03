"use client";
import * as React from "react";
import { Card, CardPanel, CardHeader, CardTitle } from "@/components/ui/card";
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
import { AlertCircle } from "lucide-react";
import { formatDate } from "@/lib/utils";
import {
  cancelSubscriptionAction,
  reactivateSubscriptionAction,
  setSeatsAction,
} from "@/app/[orgSlug]/billing/actions";

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

function SeatControl({
  orgSlug,
  currentSeats,
}: {
  orgSlug: string;
  currentSeats: number;
}) {
  const [seats, setSeats] = React.useState(String(currentSeats));
  const [pending, startTransition] = React.useTransition();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const { add: addToast } = useToast();

  function handleUpdate() {
    const n = parseInt(seats, 10);
    if (!Number.isInteger(n) || n < 1) {
      addToast({ title: "Invalid seat count", description: "Seats must be at least 1.", type: "error" });
      return;
    }
    startTransition(async () => {
      const res = await setSeatsAction({ orgSlug, seats: n });
      if (res.ok) {
        addToast({ title: "Seats updated", description: `Seat count updated to ${n}.`, type: "success" });
      } else if (res.code === "seat_limit_reached") {
        setDialogError(
          `You have ${res.used} member${res.used === 1 ? "" : "s"} — you can't drop below ${res.used} license${res.used === 1 ? "" : "s"}. Remove members first.`,
        );
        setDialogOpen(true);
      } else {
        addToast({ title: "Failed to update seats", description: res.error, type: "error" });
      }
    });
  }

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
              size="sm" // compact
              disabled={pending}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleUpdate}
              disabled={pending || seats === String(currentSeats)}
            >
              {pending ? "Saving…" : "Update"}
            </Button>
          </div>
        </div>
      </div>

      {/* Error dialog: cannot drop below current usage */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Cannot reduce seats</DialogTitle>
            <DialogDescription>You have more members than the requested seat count.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {dialogError ? (
              <Alert variant="error">
                <AlertCircle />
                <AlertTitle>Seat limit conflict</AlertTitle>
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="default" />}>OK</DialogClose>
          </DialogFooter>
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
}

export function SubscriptionSummary({
  subscription,
  orgSlug,
  canManageBilling,
}: SubscriptionSummaryProps) {
  if (!subscription) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No active subscription</CardTitle>
        </CardHeader>
        <CardPanel>
          <p className="text-sm text-muted-foreground">Choose a plan below to get started.</p>
        </CardPanel>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Current subscription
          <Badge variant={STATUS_VARIANT[subscription.status] ?? "muted"}>{subscription.status}</Badge>
          {subscription.cancelAtPeriodEnd ? (
            <Badge variant="warning">Cancels at period end</Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardPanel>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-muted-foreground">Plan</dt>
            <dd className="font-medium" data-testid="plan-name">
              {subscription.planName}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Billing</dt>
            <dd className="font-medium capitalize">{subscription.billingInterval}ly</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Renews</dt>
            <dd className="font-medium">{formatDate(subscription.currentPeriodEnd)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Current seats</dt>
            <dd className="font-medium">{subscription.seatCount}</dd>
          </div>
        </dl>

        {canManageBilling ? (
          <>
            <Separator className="my-4" />
            <SeatControl orgSlug={orgSlug} currentSeats={subscription.seatCount} />
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
      </CardPanel>
    </Card>
  );
}
