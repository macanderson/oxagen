import { redirect } from "next/navigation";
import { account } from "@/lib/routes";

export default function AccountNotificationsPage() {
  redirect(account.profile());
}
