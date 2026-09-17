import type { ReactNode } from "react";
import { HeroBackdrop } from "@/components/brand/hero-backdrop";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate grid min-h-dvh place-items-center overflow-hidden p-4">
      <HeroBackdrop intensity="hero" />
      {children}
    </div>
  );
}
