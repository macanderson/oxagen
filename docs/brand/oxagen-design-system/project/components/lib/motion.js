/*
 * motion.js — progressive-enhancement bridge to framer-motion.
 *
 * framer-motion is loaded by the consuming HTML as a UMD global (window.Motion).
 * Resolution is LAZY (read at call/render time, not module-eval) so script
 * ordering is forgiving: as long as framer-motion is present by first render,
 * components animate; if it never loads, they render statically (motion props
 * are stripped so there are no invalid-DOM-attribute warnings).
 */
import * as React from "react";

function fm() {
  return (typeof window !== "undefined" && window.Motion) || null;
}

export function hasMotion() {
  const f = fm();
  return !!(f && f.motion);
}

/** AnimatePresence passthrough that resolves framer-motion lazily. */
export function AnimatePresence(props) {
  const f = fm();
  if (f && f.AnimatePresence) return React.createElement(f.AnimatePresence, props);
  return React.createElement(React.Fragment, null, props.children);
}

export function MotionConfig(props) {
  const f = fm();
  if (f && f.MotionConfig) return React.createElement(f.MotionConfig, props);
  return React.createElement(React.Fragment, null, props.children);
}

const STRIP = new Set([
  "initial", "animate", "exit", "transition", "variants", "custom",
  "whileHover", "whileTap", "whileFocus", "whileInView", "whileDrag",
  "layout", "layoutId", "layoutScroll", "drag", "dragConstraints", "dragElastic",
  "onAnimationStart", "onAnimationComplete", "viewport", "inherit",
]);

const fallbackCache = {};

/** m("div") → framer-motion's motion.div, or a prop-stripping plain element. */
export function m(tag) {
  const f = fm();
  if (f && f.motion) return f.motion[tag];
  if (fallbackCache[tag]) return fallbackCache[tag];
  const Comp = React.forwardRef(function Plain(props, ref) {
    const clean = {};
    for (const k in props) if (!STRIP.has(k)) clean[k] = props[k];
    return React.createElement(tag, { ref, ...clean });
  });
  fallbackCache[tag] = Comp;
  return Comp;
}

/* Motion presets aligned to the product tokens. */
export const SPRING = { type: "spring", stiffness: 420, damping: 32, mass: 0.8 };
/** Bouncy spring for tactile press/hover feedback. */
export const BOUNCE = { type: "spring", stiffness: 520, damping: 14, mass: 0.6 };
export const EASE_ENTRY = [0.16, 1, 0.3, 1];
export const EASE_EXIT = [0.4, 0, 1, 1];
