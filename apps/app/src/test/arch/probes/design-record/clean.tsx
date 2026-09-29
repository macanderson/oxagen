// Probe for design-record.test.ts: a control drawn from the recipes.
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
    </div>
  );
}
