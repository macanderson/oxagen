import { SimplePage } from "@/components/shell/simple-page"

export default function PrivacyPage() {
  return (
    <SimplePage
      title="Privacy"
      description="Control your data, visibility, and how your activity is used."
      crumbs={[
        { label: "Account", href: "/account/profile" },
        { label: "Privacy", href: "/account/privacy" },
      ]}
      sections={[
        { title: "Data export", description: "Download a copy of your data." },
        { title: "Visibility", description: "Who can see your profile and activity." },
        { title: "Analytics", description: "Usage analytics and personalization." },
        { title: "Delete account", description: "Permanently remove your account." },
      ]}
    />
  )
}
