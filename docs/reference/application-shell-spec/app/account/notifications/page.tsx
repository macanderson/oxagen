import { PageHeader } from "@/components/shell/page-header"
import { NotificationPreferences } from "@/components/shell/notification-preferences"

export default function AccountNotificationsPage() {
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Notifications"
        description="Choose how and when you'd like to be notified across your organizations."
        askEntity="notification preferences"
        crumbs={[
          { label: "Account", href: "/account/profile" },
          { label: "Notifications", href: "/account/notifications" },
        ]}
      />
      <NotificationPreferences />
    </div>
  )
}
