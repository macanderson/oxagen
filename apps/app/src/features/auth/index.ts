// The sign-in flows' public surface for route files (src/app/(auth), cli, github,
// api/auth). This barrel reaches server-only modules, so import it from Server
// Components and route handlers only; client islands import their siblings.
export { getAuthUser, handleAuthRequest } from "@/server/session";
export {
  authorizeReturnPath,
  checkAuthorizeParams,
  readAuthorizeParams,
} from "./cli-authorize";
export { loadConsentChoices } from "./cli-consent";
export { CliConsentForm } from "./cli-consent-form";
export { handleGithubSetup } from "./github-setup";
export { decideInvitation } from "./invitation";
export { loadInvitation } from "./invitations";
export {
  InvitationBody,
  InvitationNotFound,
  InvitationWrongAccount,
} from "./invite-view";
export { oauthQueryOutcome } from "./auth-errors";
export { LoginForm } from "./login-form";
export { ForgotPasswordForm, ResetPasswordForm } from "./password-reset-forms";
export { AFTER_SIGNUP } from "./routes";
export { SignedInNotice } from "./signed-in-notice";
export { SignupForm } from "./signup-form";
export { TwoFactorForm } from "./two-factor-form";
export { AuthTags } from "./ui/auth-card";
export { InviteHint } from "./ui/invite-hint";
export { VerifyPanel } from "./verify-panel";
