import * as React from "react";

/** Oxagen text input. Dark-first; focus shows a jewel violet ring. */
export function Input({ size = "md", invalid = false, startIcon = null, style, className, ...props }) {
  const h = size === "sm" ? 30 : size === "lg" ? 40 : 34;
  const [focused, setFocused] = React.useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", width: "100%" }}>
      {startIcon && (
        <span style={{ position: "absolute", left: 10, display: "inline-flex", color: "var(--muted-foreground)", pointerEvents: "none" }}>
          {startIcon}
        </span>
      )}
      <input
        className={className}
        onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
        style={{
          width: "100%",
          height: h,
          padding: startIcon ? "0 12px 0 32px" : "0 12px",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          color: "var(--foreground)",
          background: "var(--background-2)",
          border: `1px solid ${invalid ? "var(--destructive)" : focused ? "var(--ring)" : "var(--input)"}`,
          borderRadius: "var(--radius-md)",
          outline: "none",
          boxShadow: focused ? "var(--glow-violet)" : "none",
          transition: "border-color var(--motion-micro), box-shadow var(--motion-micro)",
          ...style,
        }}
        {...props}
      />
    </span>
  );
}
