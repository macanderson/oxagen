/**
 * @oxagen/ui — shared motion primitives.
 *
 * The single source of truth for framer-motion (the `motion` package) easing
 * curves, durations, and reusable variants across every Oxagen surface. These
 * mirror the CSS motion tokens in `styles/globals.css` — keep the two in sync so
 * the CSS-transition components (Base UI popups, hover-lift) and the
 * framer-motion components animate identically.
 *
 * Design intent: motion is restrained — a gentle *rise + settle* on entry, a soft
 * ease-out on hover, no scale-heavy or bouncy springs. "Alive, not over done."
 *
 * Pure module: no React, no "use client". Importable from server components,
 * client components, and the framer-motion layer alike. The reduced-motion
 * provider lives separately in `components/motion-provider.tsx`.
 */

/**
 * Easing curves as cubic-bezier control-point tuples, the shape framer-motion's
 * `ease` / `transition.ease` expects. Identical curves to the `--ease-*` CSS
 * custom properties.
 */
export const easing = {
  /** Elements entering — decelerate into rest. */
  entry: [0.16, 1, 0.3, 1] as const,
  /** Hover / focus micro-interactions — gentle ease-out. */
  hover: [0.22, 1, 0.36, 1] as const,
  /** Elements leaving — accelerate out. */
  exit: [0.4, 0, 1, 1] as const,
} as const;

/** Durations in seconds (framer-motion's unit). Mirror `--motion-*` (ms). */
export const duration = {
  micro: 0.16,
  base: 0.22,
  overlay: 0.2,
  entry: 0.32,
} as const;

/**
 * Default transitions composed from the tokens above. Reuse these instead of
 * re-specifying `{ duration, ease }` inline so timing stays consistent.
 */
export const transition = {
  entry: { duration: duration.entry, ease: easing.entry },
  base: { duration: duration.base, ease: easing.hover },
  exit: { duration: duration.micro, ease: easing.exit },
} as const;

/**
 * Fade + rise on enter, fade + slight lift on exit. The workhorse variant for
 * chat messages, tool cards, and any element that mounts/unmounts. Pair with
 * framer-motion's `<AnimatePresence>` to get the exit animation.
 */
export const fadeInUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: transition.entry },
  exit: { opacity: 0, y: -4, transition: transition.exit },
} as const;

/** Plain fade, no translate — for overlays/backdrops that shouldn't drift. */
export const fade = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: duration.overlay, ease: easing.entry },
  },
  exit: {
    opacity: 0,
    transition: { duration: duration.micro, ease: easing.exit },
  },
} as const;

/**
 * Stagger container — children animate in sequence. Use on a list wrapper with
 * `variants={staggerContainer}` and `fadeInUp` on each child.
 */
export const staggerContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
} as const;
