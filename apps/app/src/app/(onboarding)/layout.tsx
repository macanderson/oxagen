import type { ReactNode } from "react";
import { HeroBackdrop } from "@/components/brand/hero-backdrop";

/**
 * Onboarding shell — the org-creation step after signup. Shares the same ember
 * hero backdrop as the (auth) group so signup → create-org reads as one branded
 * flow. The child page supplies its own centering wrapper above the backdrop.
 */
export default function OnboardingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="relative isolate min-h-dvh overflow-hidden">
      <HeroBackdrop intensity="hero" />
      {children}
    </div>
  );
}
