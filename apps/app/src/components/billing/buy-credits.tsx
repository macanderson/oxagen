"use client";
import * as React from "react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { formatCents } from "@/lib/utils";
import { buyCreditsAction } from "@/app/[orgSlug]/billing/actions";

export interface BuyCreditsProps {
  orgSlug: string;
}

const MIN_USD = 5;

interface DiscountPreview {
  grantCents: number;
  priceCents: number;
  percent: number;
  savedCents: number;
}

/**
 * Widget for purchasing additional usage credits.
 *
 * - Accepts a dollar-amount input (min $5).
 * - Shows a live discount preview via the `getDiscountPreview` server action.
 * - On submit, calls `buyCreditsAction` and redirects to Stripe.
 */
export function BuyCredits({ orgSlug }: BuyCreditsProps) {
  const [amount, setAmount] = React.useState("20");
  const [pending, startTransition] = React.useTransition();
  const { add: addToast } = useToast();

  const amountNum = parseFloat(amount);
  const isValid = Number.isFinite(amountNum) && amountNum >= MIN_USD;

  const [preview, setPreview] = React.useState<DiscountPreview | null>(null);
  const [previewPending, startPreviewTransition] = React.useTransition();

  // Debounce: refresh preview 300ms after the user stops typing.
  // Use a ref for the timer to avoid re-registering the effect on every render.
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!isValid) {
      timerRef.current = null;
      // Schedule the state clear outside the sync effect body to avoid cascading-render lint error.
      const id = setTimeout(() => setPreview(null), 0);
      return () => clearTimeout(id);
    }

    timerRef.current = setTimeout(() => {
      startPreviewTransition(async () => {
        try {
          const { getDiscountPreview } = await import(
            "./buy-credits-preview-action"
          );
          const result = await getDiscountPreview(Math.round(amountNum * 100));
          setPreview(result);
        } catch {
          // Preview failure is non-blocking.
          setPreview(null);
        }
      });
    }, 300);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [amount, amountNum, isValid]);

  function handleBuy() {
    if (!isValid) return;
    startTransition(async () => {
      const res = await buyCreditsAction({ orgSlug, amountUsd: amountNum });
      if (res.ok) {
        window.location.href = res.url;
      } else {
        addToast({
          title: "Purchase failed",
          description: res.error,
          type: "error",
        });
      }
    });
  }

  return (
    <Panel title="Buy usage credits">
      <p className="mb-4 text-sm text-muted-foreground">
        1 credit = 1¢. Volume discounts apply for larger purchases.
      </p>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="credit-amount">Amount (USD)</Label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              id="credit-amount"
              type="number"
              min={MIN_USD}
              step={5}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-28"
              disabled={pending}
            />
          </div>
          {!isValid && amount !== "" ? (
            <p className="text-xs text-destructive">
              Minimum purchase is ${MIN_USD}.
            </p>
          ) : null}
        </div>

        {/* Live discount preview */}
        {preview && isValid ? (
          <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm">
            {preview.percent > 0 ? (
              <p className="font-medium text-success">
                {preview.percent}% off — pay{" "}
                <span className="font-semibold">
                  {formatCents(preview.priceCents)}
                </span>{" "}
                for{" "}
                <span className="font-semibold">
                  {formatCents(preview.grantCents)}
                </span>{" "}
                in credits (save {formatCents(preview.savedCents)})
              </p>
            ) : (
              <p className="text-muted-foreground">
                Pay{" "}
                <span className="font-semibold">
                  {formatCents(preview.priceCents)}
                </span>{" "}
                for{" "}
                <span className="font-semibold">
                  {formatCents(preview.grantCents)}
                </span>{" "}
                in credits
              </p>
            )}
          </div>
        ) : previewPending ? (
          <p className="text-xs text-muted-foreground">Calculating…</p>
        ) : null}

        <Button
          onClick={handleBuy}
          disabled={!isValid || pending}
          variant="gradient"
          className="w-full"
        >
          {pending ? "Redirecting to Stripe…" : "Buy credits"}
        </Button>
      </div>
    </Panel>
  );
}
