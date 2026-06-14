import * as React from "react";

/** Oxagen toggle switch. On = brand violet track with a glow. */
export function Switch({ checked, defaultChecked = false, onChange, disabled = false, style, ...props }) {
  const [on, setOn] = React.useState(checked ?? defaultChecked);
  const isOn = checked ?? on;
  function toggle() {
    if (disabled) return;
    const next = !isOn;
    if (checked === undefined) setOn(next);
    onChange?.(next);
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      disabled={disabled}
      onClick={toggle}
      style={{
        position: "relative",
        width: 38,
        height: 22,
        borderRadius: 999,
        border: "1px solid",
        borderColor: isOn ? "transparent" : "var(--border-strong)",
        background: isOn ? "var(--primary)" : "var(--muted)",
        boxShadow: isOn ? "var(--glow-violet)" : "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        padding: 0,
        transition: "background var(--motion-base) var(--ease-hover), box-shadow var(--motion-base)",
        ...style,
      }}
      {...props}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: isOn ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 2px rgba(0,0,0,.4)",
          transition: "left var(--motion-base) var(--ease-hover)",
        }}
      />
    </button>
  );
}
