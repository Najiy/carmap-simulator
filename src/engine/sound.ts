import type { EngineSpec } from "./engines";

/**
 * Procedural engine audio. The fundamental is the firing frequency
 * (rpm/60 · cylinders/2); a half-order oscillator adds the lumpy character
 * of 3- and 5-cylinder engines, a double-order adds brightness, filtered
 * noise carries intake/boost hiss, and a soft waveshaper gives it teeth.
 */
class EngineSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private oscFund!: OscillatorNode;
  private oscHalf!: OscillatorNode;
  private oscDouble!: OscillatorNode;
  private gFund!: GainNode;
  private gHalf!: GainNode;
  private gDouble!: GainNode;
  private filter!: BiquadFilterNode;
  private noiseGain!: GainNode;
  /** pops route through a compressor — the "glue" that makes volleys punchy */
  private popBus!: DynamicsCompressorNode;
  private lastPing = 0;
  private lastPop = 0;
  private lastCrackleT = 0;
  private _muted = false;

  get muted() {
    return this._muted;
  }

  /** Must be called from a user gesture (the START ENGINE click). */
  ensure() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // soft distortion → lowpass → master
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 127.5 - 1) * 2.5;
      curve[i] = Math.tanh(x);
    }
    shaper.curve = curve;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 800;
    this.filter.Q.value = 0.8;
    shaper.connect(this.filter);
    this.filter.connect(this.master);

    const mkOsc = (type: OscillatorType) => {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(shaper);
      o.start();
      return [o, g] as const;
    };
    [this.oscFund, this.gFund] = mkOsc("sawtooth");
    [this.oscHalf, this.gHalf] = mkOsc("triangle");
    [this.oscDouble, this.gDouble] = mkOsc("square");

    // looped white noise → bandpass → gain → master (intake/boost hiss)
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1600;
    bp.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    noise.connect(bp);
    bp.connect(this.noiseGain);
    this.noiseGain.connect(this.master);
    noise.start();

    // pop/bang bus: fast compressor squashes overlapping bursts into one
    // fat, punchy crack instead of a mushy pile
    this.popBus = ctx.createDynamicsCompressor();
    this.popBus.threshold.value = -18;
    this.popBus.knee.value = 10;
    this.popBus.ratio.value = 9;
    this.popBus.attack.value = 0.001;
    this.popBus.release.value = 0.09;
    this.popBus.connect(ctx.destination);
  }

  setMuted(m: boolean) {
    this._muted = m;
    if (this.ctx && m) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    }
  }

  update(
    spec: EngineSpec,
    rpm: number,
    throttle: number,
    boost01: number,
    running: boolean,
    afr = 14.7,
  ) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.04) =>
      p.setTargetAtTime(v, t, tc);

    const firing = Math.max(20, (rpm / 60) * (spec.ncyl / 2));
    set(this.oscFund.frequency, firing, 0.02);
    set(this.oscHalf.frequency, firing / 2, 0.02);
    set(this.oscDouble.frequency, firing * 2, 0.02);

    set(this.gFund.gain, 0.2);
    set(this.gHalf.gain, 0.22 * spec.sound.half);
    set(this.gDouble.gain, 0.09 * spec.sound.bright);

    set(this.filter.frequency, 260 + throttle * 3200 + rpm * 0.25, 0.06);
    set(this.noiseGain.gain, running ? 0.006 + boost01 * 0.05 : 0);

    const vol = !running || this._muted
      ? 0
      : 0.07 + 0.16 * (0.3 + 0.7 * throttle) * (0.35 + 0.65 * (rpm / spec.redline));
    set(this.master.gain, vol, 0.08);

    // overrun pops & bangs: lift the throttle with revs up and the ECU still
    // reads the fuel map at the low-MAP rows — if those cells run rich, the
    // unburnt fuel lights off in the hot exhaust. The tune IS the soundtrack.
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastCrackleT) / 1000);
    this.lastCrackleT = now;
    if (running && throttle < 0.12 && rpm > 2200 && afr < 13.4) {
      const rich = Math.min(1, (13.4 - afr) / 3.2);
      const revs = Math.min(
        1,
        (rpm - 2200) / Math.max(1, spec.redline - 2200),
      );
      const rate = rich * (3 + 22 * revs); // events / sec — proper volleys
      if (Math.random() < rate * dt) {
        const bang = Math.random() < 0.1 + 0.28 * rich;
        this.pop(
          bang ? 0.65 + 0.35 * Math.random() : 0.15 + 0.4 * Math.random(),
        );
      }
    }
  }

  /** metallic tick on a knock event (rate-limited) */
  knockPing() {
    if (!this.ctx || this._muted) return;
    const now = performance.now();
    if (now - this.lastPing < 130) return;
    this.lastPing = now;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = 2400 + Math.random() * 800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.06);
  }

  /**
   * One exhaust event, layered for bite: an instant high-frequency SNAP,
   * a boom body, a couple of trailing micro-crackles, and — for the big
   * ones — a sub thump with a mid-bark. Everything runs through a tanh
   * soft-clip and the pop compressor for edge and punch.
   * intensity 0..1 — small = dry crackle, large = artillery.
   */
  pop(intensity = 0.5) {
    if (!this.ctx || this._muted) return;
    const now = performance.now();
    if (now - this.lastPop < 45) return;
    this.lastPop = now;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.002;
    const inten = Math.min(1, Math.max(0, intensity));

    // per-event output: soft clip → slight random pan → pop bus
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(128);
    for (let i = 0; i < 128; i++) curve[i] = Math.tanh((i / 63.5 - 1) * 2.6);
    shaper.curve = curve;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 0.6;
    shaper.connect(pan);
    pan.connect(this.popBus);

    const burst = (
      at: number,
      dur: number,
      level: number,
      fFrom: number,
      fTo: number,
      type: BiquadFilterType,
      q = 0.8,
    ) => {
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp((-9 * i) / len);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(fFrom, at);
      f.frequency.exponentialRampToValueAtTime(Math.max(40, fTo), at + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(level, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + dur);
      src.connect(f);
      f.connect(g);
      g.connect(shaper);
      src.start(at);
    };

    // 1) the SNAP — instant, bright, dry; this is the "crack" you feel
    burst(
      t0,
      0.022 + 0.02 * inten,
      0.5 + 0.45 * inten,
      3800 + Math.random() * 1800,
      900,
      "bandpass",
      1.1,
    );

    // 2) the body — the boom right behind it
    burst(
      t0 + 0.006,
      0.06 + 0.15 * inten,
      0.35 + 0.45 * inten,
      900 + 1500 * inten,
      120,
      "lowpass",
    );

    // 3) trailing micro-crackles — the fizz that sells it
    const tails = 1 + Math.floor(Math.random() * (2 + 2.5 * inten));
    for (let i = 0; i < tails; i++) {
      const at = t0 + 0.035 + Math.random() * (0.09 + 0.12 * inten);
      burst(
        at,
        0.015 + Math.random() * 0.03,
        (0.12 + 0.28 * inten) * (0.4 + Math.random() * 0.6),
        2500 + Math.random() * 2800,
        700,
        "bandpass",
        1.4,
      );
    }

    // 4) the BANG — sub thump + mid bark for the heavy hitters
    if (inten > 0.5) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(150 + 50 * Math.random(), t0);
      o.frequency.exponentialRampToValueAtTime(38, t0 + 0.1);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.5 * inten, t0);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
      o.connect(og);
      og.connect(shaper);
      o.start(t0);
      o.stop(t0 + 0.16);

      const bark = ctx.createOscillator();
      bark.type = "square";
      bark.frequency.setValueAtTime(300 + Math.random() * 120, t0 + 0.004);
      bark.frequency.exponentialRampToValueAtTime(90, t0 + 0.05);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.16 * inten, t0 + 0.004);
      bg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);
      const blp = ctx.createBiquadFilter();
      blp.type = "lowpass";
      blp.frequency.value = 900;
      bark.connect(blp);
      blp.connect(bg);
      bg.connect(shaper);
      bark.start(t0 + 0.004);
      bark.stop(t0 + 0.07);
    }
  }

  /** the sound of a connecting rod meeting daylight */
  explosion() {
    if (!this.ctx || this._muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const len = Math.floor(ctx.sampleRate * 1.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp((-4 * i) / len);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(5000, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.85, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    src.connect(lp);
    lp.connect(g);
    g.connect(ctx.destination);
    src.start();

    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(70, t);
    thump.frequency.exponentialRampToValueAtTime(28, t + 0.5);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.7, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    thump.connect(tg);
    tg.connect(ctx.destination);
    thump.start();
    thump.stop(t + 0.7);
  }
}

export const engineSound = new EngineSound();
