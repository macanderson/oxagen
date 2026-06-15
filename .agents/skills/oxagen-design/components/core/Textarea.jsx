import * as React from "react";

/** Oxagen multi-line textarea. Matches Input styling; violet focus glow. */
export function Textarea({ invalid = false, style, className, rows = 3, ...props }) {
  const [focused, setFocused] = React.useState(false);
  return (
    <textarea
      rows={rows}
      className={className}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
      style={{
        width: "100%",
        padding: "10px 12px",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        lineHeight: 1.55,
        color: "var(--foreground)",
        background: "var(--background-2)",
        border: `1px solid ${invalid ? "var(--destructive)" : focused ? "var(--ring)" : "var(--input)"}`,
        borderRadius: "var(--radius-md)",
        outline: "none",
        resize: "vertical",
        boxShadow: focused ? "var(--glow-violet)" : "none",
        transition: "border-color var(--motion-micro), box-shadow var(--motion-micro)",
        ...style,
      }}
      {...props}
    />
  );
}
