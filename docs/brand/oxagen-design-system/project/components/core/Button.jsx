import * as React from "react";
import { m, BOUNCE } from "../lib/motion.js";

/**
 * Oxagen Button.
 * Jewel-tone, high-contrast, with a tactile spring bounce on hover/press
 * (framer-motion). `gradient` is the signature hero action. Compact density.
 */
const RADIUS = "var(--radius-md)";

const SIZES = {
  sm: { height: 28, padding: "0 12px", fontSize: 12, gap: 6 },
  md: { height: 36, padding: "0 16px", fontSize: 13, gap: 8 },
  lg: { height: 44, padding: "0 22px", fontSize: 15, gap: 8 },
  icon: { height: 36, width: 36, padding: 0, fontSize: 13, gap: 0 },
};

function variantStyle(variant) {
  switch (variant) {
    case "gradient":
      return { background: "var(--grad-sunset)", color: "#fff", border: "1px solid transparent", boxShadow: "var(--glow-violet)" };
    case "secondary":
      return { background: "var(--secondary)", color: "var(--secondary-foreground)", border: "1px solid var(--border)" };
    case "outline":
      return { background: "transparent", color: "var(--foreground)", border: "1px solid var(--border-strong)" };
    case "ghost":
      return { background: "transparent", color: "var(--foreground)", border: "1px solid transparent" };
    case "destructive":
      return { background: "var(--destructive)", color: "var(--destructive-foreground)", border: "1px solid transparent" };
    case "link":
      return { background: "transparent", color: "var(--brand)", border: "1px solid transparent", padding: 0, height: "auto" };
    case "primary":
    default:
      return { background: "var(--primary)", color: "var(--primary-foreground)", border: "1px solid transparent" };
  }
}

export function Button({
  variant = "primary",
  size = "md",
  disabled = false,
  iconOnly = false,
  startIcon = null,
  endIcon = null,
  children,
  style,
  className,
  ...props
}) {
  const sz = SIZES[iconOnly ? "icon" : size] || SIZES.md;
  const vs = variantStyle(variant);
  const [hover, setHover] = React.useState(false);
  const MButton = m("button");
  const isLink = variant === "link";

  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: sz.gap,
    height: sz.height,
    width: iconOnly ? sz.width : "auto",
    padding: sz.padding,
    fontFamily: "var(--font-sans)",
    fontSize: sz.fontSize,
    fontWeight: 600,
    lineHeight: 1,
    letterSpacing: "-0.01em",
    borderRadius: RADIUS,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    whiteSpace: "nowrap",
    filter: !disabled && hover ? "brightness(1.08)" : "none",
    transition: "filter var(--motion-micro) var(--ease-hover), background var(--motion-micro) var(--ease-hover)",
    ...vs,
    ...style,
  };

  const motionProps = disabled || isLink
    ? {}
    : {
        whileHover: { scale: 1.035, y: -1 },
        whileTap: { scale: 0.92, y: 0 },
        transition: BOUNCE,
      };

  return (
    <MButton
      type="button"
      disabled={disabled}
      className={className}
      style={base}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...motionProps}
      {...props}
    >
      {startIcon}
      {children}
      {endIcon}
    </MButton>
  );
}
