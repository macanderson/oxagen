// How large an avatar draws. Kept out of avatar.tsx, a client module, so a
// server component such as AgentAvatar can compute the same side: a server
// render cannot call a function exported from a "use client" file.

/**
 * How much larger every avatar draws than the size its caller names. The
 * call sites keep the sizes they were laid out with, and this one factor
 * makes every avatar in the app a little easier to read.
 */
export const AVATAR_SCALE = 1.1;

/** The side, in CSS pixels, that an avatar of the named size draws at. */
export function avatarSide(size: number): number {
  return Math.round(size * AVATAR_SCALE);
}
