import { engineSound } from "./sound";

/**
 * The noise the tyres make.
 *
 * Two voices off one noise source, mixed by how hard the contact patch is
 * sliding: a resonant band that rises into a squeal on tarmac, and a broad
 * low rumble for grass and gravel. Both hang off the engine's AudioContext,
 * so they open on the same user gesture and obey the same mute.
 *
 * Squeal pitch climbs with how fast the tyre is scrubbing, which is what
 * makes a long slide sound like it is going somewhere rather than droning.
 */
class TyreSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private squealBp!: BiquadFilterNode;
  private squealGain!: GainNode;
  private rumbleGain!: GainNode;

  /** Attach to the engine's context. Safe to call every frame. */
  private ensure(): boolean {
    if (this.ctx) return true;
    const ctx = engineSound.context;
    if (!ctx) return false;
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // one looped noise buffer feeds both voices
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    // the squeal: a narrow resonant band, which is what a tyre howling
    // actually is — the tread blocks ringing as they let go and grab again
    this.squealBp = ctx.createBiquadFilter();
    this.squealBp.type = "bandpass";
    this.squealBp.frequency.value = 900;
    this.squealBp.Q.value = 7.5;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    noise.connect(this.squealBp);
    this.squealBp.connect(this.squealGain);
    this.squealGain.connect(this.master);

    // the rumble: everything a loose surface throws at the arches
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    lp.Q.value = 0.7;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    noise.connect(lp);
    lp.connect(this.rumbleGain);
    this.rumbleGain.connect(this.master);

    noise.start();
    return true;
  }

  /**
   * @param level   0..1, how hard the tyres are protesting
   * @param scrub   m/s the contact patch is sliding — sets the pitch
   * @param offTrack rumble instead of squeal
   * @param running the car is actually being driven
   */
  update(level: number, scrub: number, offTrack: boolean, running: boolean) {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.06) =>
      p.setTargetAtTime(v, t, tc);

    const on = running && !engineSound.muted ? level : 0;
    set(this.master.gain, on > 0 ? 0.6 : 0, 0.08);

    // a tyre squeals higher the faster it is being dragged across the road
    set(this.squealBp.frequency, 620 + Math.min(scrub, 22) * 62, 0.05);
    set(this.squealGain.gain, offTrack ? on * 0.05 : on * 0.34);
    set(this.rumbleGain.gain, offTrack ? on * 0.42 : on * 0.06);
  }

  /** leaving the scene — silence it without waiting for the ramp */
  silence() {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
  }
}

export const tyreSound = new TyreSound();
