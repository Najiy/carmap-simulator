import { useEffect, useRef, useState } from "react";
import { useGameStore } from "../store/gameStore";

/**
 * Header driver-name field. Click to edit; commits on blur/Enter to the
 * persistent game store (the name used across all races). If you're in a
 * multiplayer lobby, RacePanel picks up the store change and syncs it.
 */
export default function DriverName() {
  const name = useGameStore((s) => s.playerName);
  const setName = useGameStore((s) => s.setPlayerName);
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft !== null) inputRef.current?.select();
  }, [draft]);

  const commit = () => {
    if (draft !== null) {
      const clean = draft.trim().slice(0, 20);
      if (clean && clean !== name) setName(clean);
    }
    setDraft(null);
  };

  return (
    <label
      className="flex items-center gap-1.5 rounded border border-grid bg-raised px-2 py-1 text-xs"
      title="Your driver name — used in races"
    >
      <span className="text-muted">👤</span>
      <input
        ref={inputRef}
        value={draft ?? name}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setDraft(name)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        maxLength={20}
        size={Math.max(6, (draft ?? name).length)}
        className="bg-transparent font-semibold text-ink outline-none"
      />
    </label>
  );
}
