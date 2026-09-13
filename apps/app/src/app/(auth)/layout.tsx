import type { ReactNode } from "react";
import { AuthShell } from "@/features/auth";

// Every sign-in screen shares the frame; each page renders its own column.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
