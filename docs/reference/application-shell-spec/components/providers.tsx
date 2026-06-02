"use client"

import { ThemeProvider } from "next-themes"
import { ShellProvider } from "@/components/shell/shell-context"
import { NotificationsProvider } from "@/components/shell/notifications-context"
import { Toaster } from "@/components/ui/sonner"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ShellProvider>
        <NotificationsProvider>
          {children}
          <Toaster />
        </NotificationsProvider>
      </ShellProvider>
    </ThemeProvider>
  )
}
