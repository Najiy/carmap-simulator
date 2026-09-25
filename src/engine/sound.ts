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
  private oscSub!: OscillatorNode;
  private gFund!: GainNode;
  private gHalf!: GainNode;
  private gDouble!: GainNode;
  private gSub!: GainNode;
  private filter!: BiquadFilterNode;
  private noiseGain!: GainNode;
  /** pops route through a compressor — the "glue" that makes volleys punchy */
  private popBus!: DynamicsCompressorNode;
  /** short outdoor reverb — the open-air report that sells a real bang */
  private verb!: ConvolverNode;
  /** the pipe resonator — metallic ring + flutter echo inside the tube */
  private pipeIn!: GainNode;
  private lastPing = 0;
  private lastPop = 0;
  private lastCrackleT = 0;
  private volleyCooldownUntil = 0;
  private _muted = false;

  get muted() {
    return this._muted;
  }

  /**
   * The shared AudioContext, once a user gesture has opened it. The tyre
   * noise hangs off the same one — a second context would cost another
   * hardware stream and would not obey this mute flag.
   */
  get context(): AudioContext | null {
    return this.ctx;
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

    // harder distortion → lowpass → pipe resonance → low-shelf body → master:
    // big-bore straight pipe — raspier midrange, fat fundamental, and a
    // fixed ~110 Hz resonance so the exhaust DRONES when the firing
    // frequency sweeps through it
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 127.5 - 1) * 3.4;
      curve[i] = Math.tanh(x);
    }
    shaper.curve = curve;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 800;
    this.filter.Q.value = 0.8;
    const pipeRes = ctx.createBiquadFilter();
    pipeRes.type = "peaking";
    pipeRes.frequency.value = 110;
    pipeRes.Q.value = 1.3;
    pipeRes.gain.value = 6.5;
    const shelf = ctx.createBiquadFilter();
    shelf.type = "lowshelf";
    shelf.frequency.value = 200;
    shelf.gain.value = 7;
    shaper.connect(this.filter);
    this.filter.connect(pipeRes);
    pipeRes.connect(shelf);
    shelf.connect(this.master);

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
    // sub-order sine — the chest thump every straight-piped car has
    [this.oscSub, this.gSub] = mkOsc("sine");

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

    // procedural outdoor impulse response: ~0.9 s of darkening stereo decay.
    // This is what turns a dry click into a bang heard from behind the car.
    const irDur = 0.9;
    const irLen = Math.floor(ctx.sampleRate * irDur);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const w = (Math.random() * 2 - 1) * Math.exp((-5.5 * i) / irLen);
        lp += (w - lp) * 0.22; // one-pole darkening: reflections lose highs
        d[i] = lp * 1.9;
      }
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = ir;
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.9;
    this.verb.connect(verbOut);
    verbOut.connect(ctx.destination);

    // the pipe: what makes a pop sound like it happened INSIDE a metal tube.
    // A short comb with bandpassed feedback = the metallic ring of the pipe
    // walls; a ~19 ms slap with feedback = the pap fluttering down the tube.
    this.pipeIn = ctx.createGain();
    this.pipeIn.gain.value = 1;
    const pipeOut = ctx.createGain();
    pipeOut.gain.value = 0.9;
    const ring = ctx.createDelay(0.05);
    ring.delayTime.value = 0.0044;
    const ringBp = ctx.createBiquadFilter();
    ringBp.type = "bandpass";
    ringBp.frequency.value = 1050;
    ringBp.Q.value = 0.7;
    const ringFb = ctx.createGain();
    ringFb.gain.value = 0.58;
    this.pipeIn.connect(ring);
    ring.connect(ringBp);
    ringBp.connect(ringFb);
    ringFb.connect(ring);
    ring.connect(pipeOut);
    const slap = ctx.createDelay(0.1);
    slap.delayTime.value = 0.019;
    const slapLp = ctx.createBiquadFilter();
    slapLp.type = "lowpass";
    slapLp.frequency.value = 1600;
    const slapFb = ctx.createGain();
    slapFb.gain.value = 0.42;
    this.pipeIn.connect(slap);
    slap.connect(slapLp);
    slapLp.connect(slapFb);
    slapFb.connect(slap);
    slapLp.connect(pipeOut);
    pipeOut.connect(this.popBus);
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
    set(this.oscSub.frequency, Math.max(24, firing / 2), 0.02);

    set(this.gFund.gain, 0.24);
    set(this.gHalf.gain, 0.22 * spec.sound.half);
    set(this.gDouble.gain, 0.08 * spec.sound.bright);
    // the sub thump swells with load — open pipe, open lungs
    set(this.gSub.gain, 0.16 + 0.14 * throttle + 0.08 * boost01);

    set(this.filter.frequency, 300 + throttle * 3600 + rpm * 0.3, 0.06);
    // exhaust roar rises with throttle, not just boost hiss
    set(
      this.noiseGain.gain,
      running ? 0.006 + boost01 * 0.05 + throttle * 0.014 : 0,
    );

    const vol = !running || this._muted
      ? 0
      : 0.08 + 0.17 * (0.35 + 0.65 * throttle) * (0.35 + 0.65 * (rpm / spec.redline));
    set(this.master.gain, vol, 0.08);

    // overrun pops & bangs: lift the throttle with revs up and the ECU still
    // reads the fuel map at the low-MAP rows — if those cells run rich, the
    // unburnt fuel lights off in the hot exhaust. Real overrun isn't a
    // metronome: it's irregular machine-gun volleys with gaps between them.
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastCrackleT) / 1000);
    this.lastCrackleT = now;
    if (
      running &&
      throttle < 0.12 &&
      rpm > 2200 &&
      afr < 13.4 &&
      now > this.volleyCooldownUntil
    ) {
      const rich = Math.min(1, (13.4 - afr) / 3.2);
      const revs = Math.min(
        1,
        (rpm - 2200) / Math.max(1, spec.redline - 2200),
      );
      const rate = rich * (2.5 + 14 * revs); // volley windows / sec
      if (Math.random() < rate * dt) {
        if (Math.random() < 0.4 + 0.3 * rich) {
          // brrrap — a proper burst, then silence
          const n = 3 + Math.floor(Math.random() * (3 + 5 * rich));
          this.volley(n, 0.22 + 0.5 * rich);
          this.volleyCooldownUntil = now + n * 60 + 250 + Math.random() * 500;
        } else {
          const bang = Math.random() < 0.12 + 0.25 * rich;
          this.pop(
            bang ? 0.68 + 0.32 * Math.random() : 0.15 + 0.4 * Math.random(),
          );
          this.volleyCooldownUntil = now + 60;
        }
      }
    }
  }

  /** an irregular machine-gun burst of crackles — pap pap pap, tapering */
  volley(count: number, baseIntensity: number) {
    let at = 0;
    for (let i = 0; i < count; i++) {
      at += 55 + Math.random() * 55;
      const taper = 1 - (0.45 * i) / count;
      const inten =
        baseIntensity * taper * (0.55 + Math.random() * 0.65);
      const bang = Math.random() < 0.1;
      window.setTimeout(
        () => this.pop(bang ? Math.min(1, inten + 0.45) : inten),
        at,
      );
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
   * One exhaust event heard from BEHIND the car: a near-impulse detonation
   * tick, the main broadband crack, the low pressure "whump", a sub thump
   * for the heavy ones — all with an open-air reverb send so big bangs get
   * the outdoor "crack-BOOM-mm" report instead of a dry click.
   * intensity 0..1 — small = dry popcorn crackle, large = artillery.
   */
  pop(intensity = 0.5) {
    if (!this.ctx || this._muted) return;
    const now = performance.now();
    if (now - this.lastPop < 26) return;
    this.lastPop = now;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.002;
    const inten = Math.min(1, Math.max(0, intensity));

    // per-event output: soft clip → slight random pan, then split to the
    // dry pop bus and the outdoor reverb (wet grows with intensity)
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(128);
    for (let i = 0; i < 128; i++) curve[i] = Math.tanh((i / 63.5 - 1) * 2.3);
    shaper.curve = curve;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 0.5;
    shaper.connect(pan);
    const dry = ctx.createGain();
    dry.gain.value = 0.85;
    const wet = ctx.createGain();
    wet.gain.value = 0.12 + 0.55 * inten;
    const pipe = ctx.createGain();
    pipe.gain.value = 0.55 + 0.3 * inten;
    pan.connect(dry);
    pan.connect(wet);
    pan.connect(pipe);
    dry.connect(this.popBus);
    wet.connect(this.verb);
    pipe.connect(this.pipeIn);

    const burst = (
      at: number,
      dur: number,
      level: number,
      fFrom: number,
      fTo: number,
      type: BiquadFilterType,
      q = 0.8,
      decay = 9,
    ) => {
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp((-decay * i) / len);
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

    // 0) detonation tick — a ~4 ms near-impulse; the flame front arriving
    burst(t0, 0.004, 0.35 + 0.25 * inten, 6200, 3000, "highpass", 0.7, 6);

    // 1) the PAP — tonal mid punch, the mouth of the pipe speaking
    burst(
      t0 + 0.001,
      0.02 + 0.022 * inten,
      0.65 + 0.4 * inten,
      750 + Math.random() * 550,
      280,
      "bandpass",
      1.5,
      10,
    );

    // 2) the whump — the pressure wave rolling out of the pipe
    burst(
      t0 + 0.005,
      0.05 + 0.12 * inten,
      0.35 + 0.5 * inten,
      420 + 580 * inten,
      85,
      "lowpass",
      0.8,
      7,
    );

    // 3) trailing fizz — brief, quiet, only on the meatier pops
    if (inten > 0.3) {
      const tails = Math.floor(Math.random() * (1 + 2 * inten));
      for (let i = 0; i < tails; i++) {
        const at = t0 + 0.03 + Math.random() * 0.08;
        burst(
          at,
          0.012 + Math.random() * 0.02,
          (0.1 + 0.2 * inten) * (0.4 + Math.random() * 0.6),
          1800 + Math.random() * 1600,
          700,
          "bandpass",
          1.3,
          11,
        );
      }
    }

    // 4) the BANG — sub pressure thump for the heavy hitters
    if (inten > 0.5) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(130 + 40 * Math.random(), t0);
      o.frequency.exponentialRampToValueAtTime(34, t0 + 0.11);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.55 * inten, t0);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
      o.connect(og);
      og.connect(shaper);
      o.start(t0);
      o.stop(t0 + 0.17);
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
