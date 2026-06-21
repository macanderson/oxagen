import { Suspense } from "react";
import { BillingSubscriptionBody } from "./subscription-body";
import { BillingSubscriptionSkeleton } from "./subscription-skeleton";

export default async function BillingSubscriptionPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return (
    <Suspense fallback={<BillingSubscriptionSkeleton />}>
      <BillingSubscriptionBody orgSlug={orgSlug} />
    </Suspense>
  );
}
