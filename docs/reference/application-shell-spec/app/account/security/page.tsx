import { SimplePage } from "@/components/shell/simple-page"

export default function AccountSecurityPage() {
  return (
    <SimplePage
      title="Security"
      description="Protect your account with passwords, multi-factor authentication, and active sessions."
      crumbs={[
        { label: "Account", href: "/account/profile" },
        { label: "Security", href: "/account/security" },
      ]}
      sections={[
        { title: "Password", description: "Change your password." },
        { title: "Two-factor auth", description: "Authenticator apps and recovery codes." },
        { title: "Passkeys", description: "Hardware and platform passkeys." },
        { title: "Sessions", description: "Devices currently signed in." },
      ]}
    />
  )
}
