import * as React from "react";

/**
 * Oxagen Card surface + parts. `glow` adds the violet focus ring for the
 * featured card on a surface; `gradientRing` wraps it in the nebula hairline.
 */
export function Card({ glow = false, gradientRing = false, interactive = false, style, className, children, ...props }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      className={[gradientRing ? "ox-gradient-ring" : "", className].filter(Boolean).join(" ")}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--card)",
        color: "var(--card-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: glow ? "var(--glow-violet)" : interactive && hover ? "var(--shadow-lg)" : "var(--shadow-sm)",
        transform: interactive && hover ? "translateY(-2px)" : "none",
        transition: "transform var(--motion-base) var(--ease-hover), box-shadow var(--motion-base) var(--ease-hover)",
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ style, children, ...props }) {
  return <div style={{ padding: "18px 20px 0", ...style }} {...props}>{children}</div>;
}

export function CardTitle({ style, children, ...props }) {
  return (
    <h3 style={{ fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", margin: 0, ...style }} {...props}>
      {children}
    </h3>
  );
}

export function CardDescription({ style, children, ...props }) {
  return (
    <p style={{ fontFamily: "var(--font-sans)", fontSize: 13, lineHeight: 1.5, color: "var(--muted-foreground)", margin: "4px 0 0", ...style }} {...props}>
      {children}
    </p>
  );
}

export function CardBody({ style, children, ...props }) {
  return <div style={{ padding: 20, ...style }} {...props}>{children}</div>;
}

export function CardFooter({ style, children, ...props }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 20px 18px", ...style }} {...props}>
      {children}
    </div>
  );
}
