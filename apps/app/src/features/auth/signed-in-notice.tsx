// The organization layout's sign-in toast. The name is the session's, read
// through the cached session the layout's viewer check already made, and the
// address stands in when the account has no name.
import { getAuthUser } from "@/server/session";
import { SignedInToast } from "./ui/signed-in-toast";

export async function SignedInNotice() {
  const user = await getAuthUser();
  if (user === null) return null;
  return <SignedInToast name={user.name.trim() || user.email} />;
}
