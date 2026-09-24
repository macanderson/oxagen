// tacho-host-revoke.ts — the host revocation now lives in
// @oxagen/database/member-lifecycle, so a member removal in @oxagen/auth (an
// SSO deny sign-in) revokes a host through the same three writes without
// depending on this package. `revoke_tacho_enrollment` and `retire_agent`
// keep importing it from here.
export {
  retireEnrollmentKeys,
  revokeHostEnrollment,
  type RevocableHost,
} from "@oxagen/database/member-lifecycle";
