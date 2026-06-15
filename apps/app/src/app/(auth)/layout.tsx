import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="ox-mesh grid min-h-dvh place-items-center p-4">
      {children}
    </div>
  );
}
