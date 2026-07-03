import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { clamp, cloneGrid, type Axes, type Grid } from "../engine/axes";
import { engine, useCellTrace } from "../engine/store";

interface Sel {
  ar: number; // anchor load-row
  ac: number; // anchor rpm-col
  fr: number; // focus load-row
  fc: number; // focus rpm-col
}

export interface MapEditorProps {
  axes: Axes;
  grid: Grid;
  onChange: (g: Grid) => void;
  unit: string;
  decimals: number;
  min: number;
  max: number;
  step: number;
  bigStep: number;
  heatRange: [number, number];
  title: string;
  subtitle: string;
  /** fuel map only: overlay the logged AFR datalog + correction tools */
  logTools?: { targetGrid: Grid; onApplyCorrection: (sel: Sel | null) => void };
  extraToolbar?: ReactNode;
}

const heat = (t: number) => {
  const k = clamp(t, 0, 1);
  return `hsl(${Math.round(210 - 210 * k)} 52% ${27 + 9 * k}%)`;
};

const rect = (s: Sel) => ({
  r0: Math.min(s.ar, s.fr),
  r1: Math.max(s.ar, s.fr),
  c0: Math.min(s.ac, s.fc),
  c1: Math.max(s.ac, s.fc),
});

export default function MapEditor(props: MapEditorProps) {
  const { axes, grid, onChange, decimals, min, max, step, bigStep, heatRange } =
    props;
  const [sel, setSel] = useState<Sel | null>({ ar: 8, ac: 4, fr: 8, fc: 4 });
  const [buffer, setBuffer] = useState("");
  const [showLog, setShowLog] = useState(false);
  const dragging = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trace = useCellTrace();

  const fmt = useCallback(
    (v: number) => v.toFixed(decimals),
    [decimals],
  );

  const applyToSel = useCallback(
    (fn: (v: number, li: number, ri: number) => number) => {
      if (!sel) return;
      const g = cloneGrid(grid);
      const { r0, r1, c0, c1 } = rect(sel);
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++)
          g[r][c] = clamp(
            Math.round(fn(g[r][c], r, c) * 100) / 100,
            min,
            max,
          );
      onChange(g);
    },
    [sel, grid, onChange, min, max],
  );

  const commitBuffer = useCallback(() => {
    if (!buffer) return;
    const v = parseFloat(buffer);
    if (!Number.isNaN(v)) applyToSel(() => v);
    setBuffer("");
  }, [buffer, applyToSel]);

  const smooth = () => {
    if (!sel) return;
    const src = grid;
    applyToSel((_v, r, c) => {
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (src[rr]?.[cc] !== undefined) {
            sum += src[rr][cc];
            n++;
          }
        }
      return sum / n;
    });
  };

  const interpolate = (dir: "h" | "v") => {
    if (!sel) return;
    const { r0, r1, c0, c1 } = rect(sel);
    const src = grid;
    applyToSel((v, r, c) => {
      if (dir === "h") {
        if (c1 === c0) return v;
        const t = (c - c0) / (c1 - c0);
        return src[r][c0] + (src[r][c1] - src[r][c0]) * t;
      }
      if (r1 === r0) return v;
      const t = (r - r0) / (r1 - r0);
      return src[r0][c] + (src[r1][c] - src[r0][c]) * t;
    });
  };

  const move = (dr: number, dc: number, extend: boolean) => {
    commitBuffer();
    setSel((s) => {
      const base = s ?? { ar: 0, ac: 0, fr: 0, fc: 0 };
      const fr = clamp(base.fr + dr, 0, axes.load.length - 1);
      const fc = clamp(base.fc + dc, 0, axes.rpm.length - 1);
      return extend ? { ...base, fr, fc } : { ar: fr, ac: fc, fr, fc };
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    // rows render top→bottom as high→low load, so ArrowUp = +load
    if (k === "ArrowUp") move(1, 0, e.shiftKey);
    else if (k === "ArrowDown") move(-1, 0, e.shiftKey);
    else if (k === "ArrowLeft") move(0, -1, e.shiftKey);
    else if (k === "ArrowRight") move(0, 1, e.shiftKey);
    else if (k === "+" || k === "=") applyToSel((v) => v + step);
    else if (k === "-" || k === "_") applyToSel((v) => v - step);
    else if (k === "PageUp") applyToSel((v) => v + bigStep);
    else if (k === "PageDown") applyToSel((v) => v - bigStep);
    else if (/^[0-9.]$/.test(k)) {
      setBuffer((b) => (b + k).slice(0, 7));
      e.preventDefault();
      return;
    } else if (k === "Enter") commitBuffer();
    else if (k === "Backspace") setBuffer((b) => b.slice(0, -1));
    else if (k === "Escape") setBuffer("");
    else return;
    e.preventDefault();
  };

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const selRect = sel ? rect(sel) : null;
  const focusVal = sel ? grid[sel.fr][sel.fc] : null;
  const [heatLo, heatHi] = heatRange;
  const logGrid = props.logTools && showLog ? engine.afrLog : null;

  // rows displayed high-load first, like real tuning software
  const rowOrder = axes.load.map((_, i) => i).reverse();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header + toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-grid px-4 py-2">
        <div className="mr-auto">
          <div className="text-sm font-semibold">{props.title}</div>
          <div className="text-xs text-muted">{props.subtitle}</div>
        </div>
        {sel && (
          <div className="tabular rounded bg-raised px-2 py-1 text-xs text-ink2">
            {axes.rpm[sel.fc]} rpm · {axes.load[sel.fr]} kPa ={" "}
            <span className="font-semibold text-ink">
              {buffer ? (
                <span className="text-warn">{buffer}▏</span>
              ) : (
                focusVal !== null && fmt(focusVal)
              )}
            </span>{" "}
            {props.unit}
          </div>
        )}
        <ToolButton onClick={() => applyToSel((v) => v - step)}>
          −{step}
        </ToolButton>
        <ToolButton onClick={() => applyToSel((v) => v + step)}>
          +{step}
        </ToolButton>
        <ToolButton onClick={() => applyToSel((v) => v * 0.95)}>
          ×0.95
        </ToolButton>
        <ToolButton onClick={() => applyToSel((v) => v * 1.05)}>
          ×1.05
        </ToolButton>
        <ToolButton onClick={smooth}>Smooth</ToolButton>
        <ToolButton onClick={() => interpolate("h")}>Interp →</ToolButton>
        <ToolButton onClick={() => interpolate("v")}>Interp ↓</ToolButton>
        {props.logTools && (
          <>
            <ToolButton
              active={showLog}
              onClick={() => setShowLog((s) => !s)}
            >
              Logged AFR
            </ToolButton>
            <ToolButton onClick={() => props.logTools!.onApplyCorrection(sel)}>
              Apply AFR correction
            </ToolButton>
            <ToolButton onClick={() => engine.clearAfrLog()}>
              Clear log
            </ToolButton>
          </>
        )}
        {props.extraToolbar}
      </div>

      {/* the table */}
      <div
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={commitBuffer}
        className="min-h-0 flex-1 overflow-auto p-3 outline-none"
      >
        <div
          className="grid select-none gap-px"
          style={{
            gridTemplateColumns: `52px repeat(${axes.rpm.length}, minmax(50px, 1fr))`,
            minWidth: 52 + axes.rpm.length * 51,
          }}
        >
          {/* rpm header row */}
          <div className="sticky top-0 z-10 bg-page px-1 py-1 text-right text-[10px] text-muted">
            kPa \ rpm
          </div>
          {axes.rpm.map((r) => (
            <div
              key={r}
              className="tabular sticky top-0 z-10 bg-page py-1 text-center text-[11px] font-semibold text-ink2"
            >
              {r}
            </div>
          ))}

          {rowOrder.map((li) => (
            <RowCells
              key={li}
              axes={axes}
              li={li}
              grid={grid}
              fmt={fmt}
              heatLo={heatLo}
              heatHi={heatHi}
              selRect={selRect}
              focus={sel ? { r: sel.fr, c: sel.fc } : null}
              trace={trace}
              logGrid={logGrid}
              targetGrid={props.logTools?.targetGrid ?? null}
              onDown={(li2, ri, shift) => {
                wrapRef.current?.focus();
                dragging.current = true;
                commitBuffer();
                setSel((s) =>
                  shift && s
                    ? { ...s, fr: li2, fc: ri }
                    : { ar: li2, ac: ri, fr: li2, fc: ri },
                );
              }}
              onEnter={(li2, ri) => {
                if (dragging.current)
                  setSel((s) => (s ? { ...s, fr: li2, fc: ri } : s));
              }}
            />
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Click/drag to select · arrows move (Shift extends) · type a number +
          Enter to set · <span className="text-ink2">+/−</span> step ·{" "}
          <span className="text-ink2">PgUp/PgDn</span> big step · the{" "}
          <span className="text-s1">blue ring</span> is where the engine is
          running right now
        </p>
      </div>
    </div>
  );
}

function ToolButton({
  children,
  onClick,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.94 }}
      onMouseDown={(e) => e.preventDefault()} // keep table focus
      onClick={onClick}
      className={`rounded border px-2 py-1 text-xs transition-colors ${
        active
          ? "border-s1 bg-s1/20 text-ink"
          : "border-grid bg-raised text-ink2 hover:border-axis hover:text-ink"
      }`}
    >
      {children}
    </motion.button>
  );
}

function RowCells({
  axes,
  li,
  grid,
  fmt,
  heatLo,
  heatHi,
  selRect,
  focus,
  trace,
  logGrid,
  targetGrid,
  onDown,
  onEnter,
}: {
  axes: Axes;
  li: number;
  grid: Grid;
  fmt: (v: number) => string;
  heatLo: number;
  heatHi: number;
  selRect: { r0: number; r1: number; c0: number; c1: number } | null;
  focus: { r: number; c: number } | null;
  trace: { ri: number; li: number };
  logGrid: Grid | null;
  targetGrid: Grid | null;
  onDown: (li: number, ri: number, shift: boolean) => void;
  onEnter: (li: number, ri: number) => void;
}) {
  return (
    <>
      <div className="tabular flex items-center justify-end pr-2 text-[11px] font-semibold text-ink2">
        {axes.load[li]}
      </div>
      {axes.rpm.map((_, ri) => {
        const v = grid[li][ri];
        const t = (v - heatLo) / (heatHi - heatLo);
        const selected =
          selRect &&
          li >= selRect.r0 &&
          li <= selRect.r1 &&
          ri >= selRect.c0 &&
          ri <= selRect.c1;
        const isFocus = focus && focus.r === li && focus.c === ri;
        const isTrace = trace.li === li && trace.ri === ri;
        const logV = logGrid ? logGrid[li][ri] : NaN;
        let logColor = "text-ink2";
        if (targetGrid && !Number.isNaN(logV)) {
          const d = logV - targetGrid[li][ri];
          logColor =
            d > 0.35 ? "text-crit" : d < -0.35 ? "text-s1" : "text-good";
        }
        return (
          <div
            key={ri}
            onMouseDown={(e) => {
              e.preventDefault();
              onDown(li, ri, e.shiftKey);
            }}
            onMouseEnter={() => onEnter(li, ri)}
            className={`tabular relative cursor-cell px-0.5 py-1 text-center text-[11px] leading-tight text-white/90 ${
              selected ? "brightness-150" : "hover:brightness-125"
            }`}
            style={{
              background: heat(t),
              boxShadow: isFocus
                ? "inset 0 0 0 2px #ffffff"
                : selected
                  ? "inset 0 0 0 1px rgba(255,255,255,0.55)"
                  : undefined,
            }}
          >
            {fmt(v)}
            {logGrid && (
              <div className={`text-[9px] ${logColor}`}>
                {Number.isNaN(logV) ? "·" : logV.toFixed(1)}
              </div>
            )}
            {isTrace && (
              <motion.div
                layoutId="cell-trace"
                className="pointer-events-none absolute inset-0"
                style={{ boxShadow: "inset 0 0 0 2px #3987e5" }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
