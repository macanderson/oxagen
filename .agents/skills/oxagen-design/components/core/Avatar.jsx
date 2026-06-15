import * as React from "react";

/**
 * Oxagen Avatar. Renders an image, or initials on a deterministic jewel
 * gradient derived from the name. `gradient` forces the brand cosmos sweep.
 */
const GRADS = ["var(--grad-aurora)", "var(--grad-sunset)", "var(--grad-cosmos)", "var(--grad-nebula)"];

function hash(s = "") {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function Avatar({ src, name = "", size = 32, gradient = false, style, ...props }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
  const bg = gradient ? "var(--grad-cosmos)" : GRADS[hash(name) % GRADS.length];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        overflow: "hidden",
        flexShrink: 0,
        background: src ? "var(--muted)" : bg,
        color: "#fff",
        fontFamily: "var(--font-sans)",
        fontWeight: 600,
        fontSize: Math.round(size * 0.4),
        border: "1px solid var(--border)",
        ...style,
      }}
      {...props}
    >
      {src ? (
        <img src={src} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        initials || "?"
      )}
    </span>
  );
}
