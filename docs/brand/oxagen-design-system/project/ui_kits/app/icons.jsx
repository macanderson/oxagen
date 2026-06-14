/*
 * Icon — renders a Lucide icon (the icon set the Oxagen app uses, lucide-react).
 * Loaded from the lucide UMD CDN; each Icon converts its own <i data-lucide>
 * into an inline <svg> that inherits currentColor, so re-renders stay safe.
 */
function Icon({ name, size = 16, strokeWidth = 2, color, style }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !window.lucide) return;
    el.innerHTML = "";
    const i = document.createElement("i");
    i.setAttribute("data-lucide", name);
    el.appendChild(i);
    try {
      window.lucide.createIcons({
        attrs: { width: size, height: size, "stroke-width": strokeWidth },
        nameAttr: "data-lucide",
      });
    } catch (e) { /* lucide not ready */ }
  });
  return (
    <span
      ref={ref}
      aria-hidden="true"
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", color: color || "inherit", width: size, height: size, flexShrink: 0, ...style }}
    />
  );
}

window.Icon = Icon;
