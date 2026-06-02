import { AppShell } from "@/components/shell/app-shell"

export default function OrgLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
