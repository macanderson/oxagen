import { Suspense } from "react";
import { LoadingRegion, TableSkeleton } from "@/components/loading";
import { DeveloperTokensBody } from "./tokens-body";

/**
 * Shell renders immediately; the API-key read streams in behind Suspense —
 * mirrors the billing subscription tab's page/body split.
 */
export default async function DeveloperTokensPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return (
    <Suspense
      fallback={
        <LoadingRegion label="Loading tokens">
          <TableSkeleton />
        </LoadingRegion>
      }
    >
      <DeveloperTokensBody orgSlug={orgSlug} />
    </Suspense>
  );
}
