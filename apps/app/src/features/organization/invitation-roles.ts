export const INVITABLE_ROLES = ["member", "admin", "owner"] as const;

export type InvitableRole = (typeof INVITABLE_ROLES)[number];
