import { Suspense } from "react";
import { GateSkeleton, WelcomeScreen } from "@/features/onboarding";

// The onboarding gate (spec §4.4): name the organization → wrap an agent → start a run.
// Steps render in place; the bare route is step 1.
export default function WelcomePage(props: PageProps<"/welcome/[[...step]]">) {
  return (
    <Suspense fallback={<GateSkeleton />}>
      <WelcomeScreen params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}
