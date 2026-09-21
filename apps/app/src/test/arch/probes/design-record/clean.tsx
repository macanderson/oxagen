// Probe for design-record.test.ts: a control drawn from the recipes.
import { buttonPrimary, statTile } from "../../../../ui/control-styles";
export function Clean() {
  return (
    <div className={statTile}>
      <button type="button" className={buttonPrimary} />
    </div>
  );
}
