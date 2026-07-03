import { isUnlocked } from "../engine/defaults";

const sections = [
  {
    title: "What you're looking at",
    body: (
      <>
        <p>
          This is an open-loop <b>speed-density</b> ECU wired to whichever
          engine you pick in the header — each has its own breathing, turbo
          (or none), injectors, redline and knock tolerance, and its maps are
          scaled to match. The ECU knows only two things about the engine at
          any instant: <b>RPM</b> and <b>manifold pressure (MAP, kPa)</b>. It
          uses them to look up your tables — bilinear-interpolated between
          cells, exactly like real firmware — and commands an injector pulse
          width and a spark angle. Whether those commands are right is up to
          you. Swapping engines fits fresh hardware and a fresh base
          calibration.
        </p>
        <p>
          100 kPa is atmospheric. Rows above 100 kPa only happen under boost;
          rows near 20–40 kPa are closed-throttle and cruise. The blue ring on
          a table is the cell the engine is running in right now.
        </p>
      </>
    ),
  },
  {
    title: "Fuel map (pulse width, ms)",
    body: (
      <>
        <p>
          Each cell is how long the injector stays open per engine cycle. More
          milliseconds = more fuel = <b>richer</b> (lower AFR). The wideband
          gauge shows the result: 14.7 is chemically perfect (stoich), 12.5–13
          makes best power, anything leaner than ~15 under boost melts pistons.
        </p>
        <p className="font-semibold text-ink">Workflow:</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Set your AFR targets (the AFR Target tab is your reference).</li>
          <li>
            Drive the engine through the cells: use <b>Hold RPM</b> + throttle
            to park it in a cell, or make dyno pulls for the WOT row.
          </li>
          <li>
            Toggle <b>Logged AFR</b> on the fuel map — every visited cell shows
            what the wideband actually read there. Green = on target, red =
            lean, blue = rich.
          </li>
          <li>
            Fix cells by hand (lean → add ms), or select a region and hit{" "}
            <b>Apply AFR correction</b> — it rescales pulse width by
            (measured ÷ target), which is exactly what "VE analyzer" tools do.
          </li>
          <li>Clear the log, re-run, repeat until the error is gone.</li>
        </ol>
        <p>
          Every base calibration was built assuming one flat volumetric
          efficiency number. Each real engine breathes hardest somewhere
          different (the K20 when VTEC engages, the RB26 past 5500) — so the
          map is <b>lean right where cylinder pressure peaks</b>. Find it
          before it finds you.
        </p>
      </>
    ),
  },
  {
    title: "Ignition map (° BTDC)",
    body: (
      <>
        <p>
          Spark advance: how many degrees before top-dead-center the mixture is
          lit. More advance = more torque, up to <b>MBT</b> (maximum brake
          torque). Past the <b>knock threshold</b> the mixture detonates —
          the KNOCK lamp flashes, and every event chips engine health.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            At light load you cannot knock — advance until torque stops
            improving (MBT is in the low-to-mid 30s°).
          </li>
          <li>
            Under boost the knock threshold drops <i>below</i> MBT. High-load
            cells are knock-limited: advance until the first trace of knock,
            then back off 2°.
          </li>
          <li>
            Richer mixtures cool the chamber and buy back knock margin —
            fuel and spark are tuned together, not separately.
          </li>
          <li>
            Retarded timing wastes torque and dumps heat into the exhaust —
            watch EGT climb when you pull timing.
          </li>
        </ul>
      </>
    ),
  },
  {
    title: "AFR targets — what to aim for",
    body: (
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <b>14.7</b> — cruise and light load (≤ 60 kPa): clean and efficient.
        </li>
        <li>
          <b>13.0–13.8</b> — mid load: transition toward power mixture.
        </li>
        <li>
          <b>12.0–12.5</b> — full load NA (100 kPa): best-power mixture.
        </li>
        <li>
          <b>11.6–12.0</b> — boost: extra fuel is knock insurance and keeps
          EGTs survivable. Rich is slow; lean is broken.
        </li>
      </ul>
    ),
  },
  {
    title: "How the engine gets hurt",
    body: (
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <b>Knock</b> — each event damages health; harder knock (more degrees
          past the threshold) does exponentially more.
        </li>
        <li>
          <b>Lean under boost</b> — AFR above ~15.2 past 120 kPa burns the
          engine down even without knock.
        </li>
        <li>
          <b>EGT over 1000 °C</b> — melts turbos and valves; caused by lean
          mixtures and heavily retarded timing.
        </li>
        <li>
          Injector duty over ~85% means the injectors are running out — you
          can't fix lean with a map that's already maxed out.
        </li>
        <li>
          Below 50% health the engine loses compression and power. At 0% it
          lets go — rebuild and tune more carefully.
        </li>
      </ul>
    ),
  },
  {
    title: "A sensible first session",
    body: (
      <ol className="list-decimal space-y-1 pl-5">
        <li>Start the engine; let it idle. Watch the trace sit in the low-kPa cells.</li>
        <li>
          Turn the wastegate down to 120 kPa while the fuel map is unproven.
        </li>
        <li>
          Hold 3000 rpm at part throttle, log AFR, correct the cruise cells.
        </li>
        <li>Make a dyno pull. Look at the AFR strip — fix the lean spots.</li>
        <li>
          Dyno numbers are <b>wheel</b> figures: the rollers read ~15% below
          the crank rating on the spec sheet (280 crank hp ≈ 238 whp). The
          stats card shows the crank estimate next to each peak.
        </li>
        <li>
          When fueling tracks target everywhere, raise boost in steps and
          re-check fuel each time.
        </li>
        <li>
          Only then chase timing: add advance cell-by-cell at load until knock
          appears, back off 2°, and compare dyno ghosts to see the gains.
        </li>
        {isUnlocked() && (
          <li>
            Stuck? Load the <b>Pro tune</b> preset and study what finished
            maps look like — then reload the base map and get yours to match
            its dyno curve.
          </li>
        )}
      </ol>
    ),
  },
];

export default function HelpPanel() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h2 className="text-lg font-bold">Tuning guide</h2>
          <p className="text-sm text-muted">
            Everything here works the way it does in real calibration software
            — simplified physics, honest cause and effect.
          </p>
        </div>
        {sections.map((s) => (
          <section key={s.title}>
            <h3 className="mb-2 border-b border-grid pb-1 text-sm font-bold text-s1">
              {s.title}
            </h3>
            <div className="space-y-2 text-sm leading-relaxed text-ink2">
              {s.body}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
