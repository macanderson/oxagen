import { Card, CardPanel, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatDate } from "@/lib/utils";

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

export function SubscriptionSummary({ subscription }: { subscription: Subscription | null }) {
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
          {subscription.cancelAtPeriodEnd ? <Badge variant="warning">Cancels at period end</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardPanel>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-muted-foreground">Plan</dt>
            <dd className="font-medium" data-testid="plan-name">{subscription.planName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Billing</dt>
            <dd className="font-medium capitalize">{subscription.billingInterval}ly</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Seats</dt>
            <dd className="font-medium">{subscription.seatCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Renews</dt>
            <dd className="font-medium">{formatDate(subscription.currentPeriodEnd)}</dd>
          </div>
        </dl>
        <Separator className="my-4" />
        <p className="text-xs text-muted-foreground">
          Period {formatDate(subscription.currentPeriodStart)} → {formatDate(subscription.currentPeriodEnd)}
        </p>
      </CardPanel>
    </Card>
  );
}
