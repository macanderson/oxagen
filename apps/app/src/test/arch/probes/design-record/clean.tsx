// Probe for design-record.test.ts: a control drawn from the recipes.
// The wordmark alone reaches Space Grotesk, through `.ox-wordmark`.
import { buttonPrimary, statTile } from "../../../../ui/control-styles";
export function Clean() {
  return (
    <div className={statTile}>
      <button type="button" className={buttonPrimary} />
      <p
        style={{
          borderColor: "color-mix(in oklab, var(--border) 60%, transparent)",
        }}
      >
        mix
      </p>
      <p style={{ font: "var(--ox-font)" }}>token</p>
      <span className="ox-wordmark">Oxagen</span>
    </div>
  );
}
