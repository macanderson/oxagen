"use client";

/**
 * MotionProvider — app-wide framer-motion config.
 *
 * Wraps the tree in framer-motion's `MotionConfig` with `reducedMotion="user"`
 * so every `motion.*` element automatically honours the OS "reduce motion"
 * setting (transforms/opacity collapse to instant) — matching the global CSS
 * `prefers-reduced-motion` kill-switch in `styles/globals.css`. Mount once near
 * the app root, inside the ThemeProvider.
 */

import * as React from "react";
import { MotionConfig } from "motion/react";

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
