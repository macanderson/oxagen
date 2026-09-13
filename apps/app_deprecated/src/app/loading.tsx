import { LoadingRegion } from "@/components/loading";

/**
 * Root loading boundary. Under Cache Components every runtime data access
 * (cookies/headers/params/uncached IO) must sit below a Suspense boundary;
 * this file is that boundary for the segments without a closer one (the `/`
 * session-redirect page, (auth), (onboarding), account, cli, github). Deeper
 * segments keep their own richer skeletons ([orgSlug]/loading.tsx etc.).
 *
 * Deliberately minimal: everything it covers is a redirect or a small form,
 * so a full-page skeleton would flash more chrome than the page it precedes.
 */
export default function Loading() {
  return (
    <LoadingRegion
      label="Loading"
      className="flex min-h-dvh items-center justify-center"
    >
      <div
        aria-hidden
        className="size-6 animate-spin rounded-full border-2 border-border border-t-foreground"
      />
    </LoadingRegion>
  );
}
