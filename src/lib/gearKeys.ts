import { engine } from "../engine/store";

/**
 * The gearbox keys, bound exactly once however many panels want them.
 *
 * Both the dyno sidebar and the driving game want Q/E and the digits, and each
 * used to install its own window listener. On desktop both are mounted at once,
 * so a single press ran two *relative* shifts and the box jumped two gears.
 *
 * The keys are handled here instead, once, and subscribers are told that a
 * change happened rather than making it themselves.
 */

interface Sub {
  /** the driver worked the gearbox by hand — used to drop out of auto */
  onShift?: () => void;
}

const subs = new Set<Sub>();

/** never steal a keystroke from a text field or the map editor's grid */
const isTyping = (e: KeyboardEvent) =>
  !!(e.target as HTMLElement | null)?.closest?.(
    "input,textarea,select,[tabindex]",
  );

function onKeyDown(e: KeyboardEvent) {
  if (e.repeat || isTyping(e)) return;
  const k = e.key.toLowerCase();
  if (k === "e") engine.shift(1);
  else if (k === "q") engine.shift(-1);
  else if (/^[0-9]$/.test(k)) engine.setGear(Number(k) - 1);
  else return;
  subs.forEach((s) => s.onShift?.());
}

/** Returns an unsubscribe. The listener lives only while someone wants it. */
export function bindGearKeys(sub: Sub = {}): () => void {
  if (subs.size === 0) window.addEventListener("keydown", onKeyDown);
  subs.add(sub);
  return () => {
    subs.delete(sub);
    if (subs.size === 0) window.removeEventListener("keydown", onKeyDown);
  };
}
