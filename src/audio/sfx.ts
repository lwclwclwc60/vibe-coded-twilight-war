import type { GunKind, MeleeKind } from '../game/types';
import type { ReloadCue } from '../game/tuning';

export type FootstepSurface = 'hard' | 'soft' | 'wood';

const FOOTSTEP_MIX: Record<FootstepSurface, { filter: number; duration: number; thump: number }> = {
  hard: { filter: 2450, duration: 0.085, thump: 112 },
  soft: { filter: 1500, duration: 0.12, thump: 78 },
  wood: { filter: 1950, duration: 0.095, thump: 155 },
};

export const SHOT_MIX: Record<GunKind, { gain: number }> = {
  pistol: { gain: 0.34 },
  rifle: { gain: 0.35 },
  shotgun: { gain: 0.38 },
  sniper: { gain: 0.37 },
};

type SampleKey =
  | 'pistol'
  | 'rifle'
  | 'shotgun'
  | 'sniper'
  | 'greatsword'
  | 'knife'
  | 'claw'
  | 'shieldBash'
  | 'hit'
  | 'switch'
  | 'playerDown';

const SAMPLE_FILES: Record<SampleKey, string> = {
  pistol: 'pistol-shot.wav',
  rifle: 'rifle-shot.wav',
  shotgun: 'shotgun-shot.wav',
  sniper: 'sniper-shot.wav',
  greatsword: 'greatsword-slash.wav',
  knife: 'knife-slash.wav',
  claw: 'claw-slash.wav',
  shieldBash: 'shield-bash.wav',
  hit: 'melee-hit.wav',
  switch: 'weapon-switch.wav',
  playerDown: 'player-down.wav',
};

interface PlaySampleOptions {
  volume: number;
  fallback: () => void;
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private sampleBuffers = new Map<SampleKey, Promise<AudioBuffer | null>>();
  private output: DynamicsCompressorNode | null = null;
  private master: GainNode | null = null;
  private activeCharge: { source: OscillatorNode; gain: GainNode } | null = null;
  private isMuted = false;

  get muted() {
    return this.isMuted;
  }

  set muted(value: boolean) {
    this.isMuted = value;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(value ? 0 : 1, this.ctx.currentTime, 0.015);
    if (value) this.setMeleeCharge(null);
  }

  unlock() {
    this.ensureContext();
    this.prepareSamples();
  }

  private ensureContext(resume = true): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        this.ctx = ctx;
        this.output = ctx.createDynamicsCompressor();
        this.output.threshold.value = -15;
        this.output.knee.value = 12;
        this.output.ratio.value = 4;
        this.output.attack.value = 0.004;
        this.output.release.value = 0.12;
        this.master = ctx.createGain();
        this.output.connect(this.master).connect(ctx.destination);
      }
    }
    if (resume && this.ctx?.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private playTone(
    freq: number,
    endFreq: number,
    duration: number,
    type: OscillatorType,
    gainVal: number,
    delay = 0
  ) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);

    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(this.output!);
    osc.start(now);
    osc.stop(now + duration + 0.01);
  }

  private playNoise(duration: number, gainVal: number, filterFreq = 1200, delay = 0) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const bufferSize = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.4));
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFreq, ctx.currentTime);

    const gain = ctx.createGain();
    const now = ctx.currentTime + delay;
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.output!);
    noise.start(now);
  }

  private loadSample(ctx: AudioContext, key: SampleKey): Promise<AudioBuffer | null> {
    const existing = this.sampleBuffers.get(key);
    if (existing) return existing;
    const promise = fetch(`${import.meta.env.BASE_URL}assets/audio/${SAMPLE_FILES[key]}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Audio sample unavailable: ${SAMPLE_FILES[key]}`);
        return response.arrayBuffer();
      })
      .then((bytes) => ctx.decodeAudioData(bytes))
      .catch(() => null);
    this.sampleBuffers.set(key, promise);
    return promise;
  }

  prepareSamples() {
    const ctx = this.ensureContext(false);
    if (!ctx) return;
    for (const key of Object.keys(SAMPLE_FILES) as SampleKey[]) {
      void this.loadSample(ctx, key);
    }
  }

  prepareGunshot() {
    this.prepareSamples();
  }

  private playSample(key: SampleKey, opts: PlaySampleOptions) {
    const ctx = this.ensureContext();
    if (!ctx || opts.volume <= 0) return;
    const bufferPromise = this.loadSample(ctx, key);
    void bufferPromise.then((buffer) => {
      if (this.muted) return;
      if (!buffer) {
        opts.fallback();
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const gain = ctx.createGain();
      gain.gain.value = opts.volume;
      source.connect(gain).connect(this.output!);
      source.start();
    });
  }

  gunshot(kind: GunKind, volume = 1) {
    if (volume <= 0) return;
    const mix = SHOT_MIX[kind];
    this.playSample(kind, {
      volume: mix.gain * volume,
      fallback: () => this.playNoise(0.15, 0.17 * volume, 3800),
    });
  }

  footstep(surface: FootstepSurface, volume = 1) {
    if (volume <= 0) return;
    const mix = FOOTSTEP_MIX[surface];
    this.playNoise(mix.duration, 0.36 * volume, mix.filter);
    this.playNoise(0.06, 0.16 * volume, mix.filter * 0.82, 0.024);
    this.playTone(mix.thump, mix.thump * 0.54, 0.095, 'sine', 0.185 * volume);
  }

  setMeleeCharge(progress: number | null) {
    if (progress === null) {
      if (!this.activeCharge || !this.ctx) return;
      const { source, gain } = this.activeCharge;
      const now = this.ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0.001, now, 0.018);
      source.stop(now + 0.10);
      this.activeCharge = null;
      return;
    }

    const ctx = this.ensureContext();
    if (!ctx) return;
    if (!this.activeCharge) {
      const source = ctx.createOscillator();
      const gain = ctx.createGain();
      source.type = 'triangle';
      source.frequency.value = 106;
      gain.gain.value = 0.001;
      source.connect(gain).connect(this.output!);
      source.start();
      this.activeCharge = { source, gain };
      this.playNoise(0.11, 0.13, 1250);
    }
    this.activeCharge.source.frequency.setTargetAtTime(106 + 132 * progress, ctx.currentTime, 0.065);
    this.activeCharge.gain.gain.setTargetAtTime(0.073 + 0.073 * progress, ctx.currentTime, 0.04);
  }

  meleeReady() {
    this.playNoise(0.17, 0.13, 1350);
    this.playTone(218, 207, 0.19, 'sine', 0.17);
    this.playTone(326, 306, 0.26, 'triangle', 0.11, 0.085);
    this.playTone(106, 53, 0.22, 'sine', 0.12, 0.08);
  }

  shieldBash(volume = 1) {
    if (volume <= 0) return;
    this.playSample('shieldBash', {
      volume: 0.50 * volume,
      fallback: () => {
        this.playNoise(0.11, 0.22 * volume, 980);
        this.playTone(98, 42, 0.11, 'sine', 0.12 * volume);
      },
    });
  }

  slash(kindOrHeavy: MeleeKind | boolean = false, volume = 1) {
    if (volume <= 0) return;
    if (kindOrHeavy === 'shield') {
      this.shieldBash(volume);
      return;
    }
    if (kindOrHeavy === 'greatsword' || kindOrHeavy === true) {
      this.playSample('greatsword', {
        volume: 0.52 * volume,
        fallback: () => {
          this.playNoise(0.22, 0.30 * volume, 1350);
          this.playTone(240, 85, 0.18, 'triangle', 0.14 * volume);
        },
      });
      return;
    }
    if (kindOrHeavy === 'claw') {
      this.playSample('claw', {
        volume: 0.44 * volume,
        fallback: () => {
          this.playNoise(0.095, 0.27 * volume, 3600);
          this.playTone(1150, 380, 0.075, 'triangle', 0.13 * volume);
        },
      });
      return;
    }
    this.playSample('knife', {
      volume: 0.44 * volume,
      fallback: () => {
        this.playNoise(0.11, 0.28 * volume, 4200);
        this.playTone(1450, 420, 0.085, 'triangle', 0.14 * volume);
      },
    });
  }

  ultimate() {
    this.playNoise(0.23, 0.18, 1550);
    this.playTone(135, 41, 0.24, 'sine', 0.10);
  }

  switchWeapon(comboCancel = false) {
    this.playSample('switch', {
      volume: comboCancel ? 0.34 : 0.22,
      fallback: () => this.playNoise(0.05, comboCancel ? 0.095 : 0.06, 2600),
    });
  }

  emptyGun() {
    this.playNoise(0.065, 0.20, 2700);
    this.playNoise(0.04, 0.11, 1400, 0.05);
  }

  reload(kind: GunKind, cue: ReloadCue) {
    const weight = kind === 'shotgun' || kind === 'sniper' ? 0.78 : 1;
    const clack = (duration: number, volume: number, cutoff: number, delay = 0) =>
      this.playNoise(duration, volume, cutoff * weight, delay);

    switch (cue) {
      case 'start':
        clack(0.12, 0.32, 2400);
        clack(0.12, 0.22, 1300, 0.055);
        break;
      case 'remove':
        clack(0.17, 0.34, 3700);
        clack(0.12, 0.23, 2300, 0.06);
        break;
      case 'insert':
        clack(0.17, 0.35, 2000);
        clack(0.09, 0.35, 4100, 0.075);
        this.playTone(520 * weight, 290 * weight, 0.055, 'triangle', 0.09, 0.075);
        if (kind === 'shotgun') clack(0.11, 0.26, 2800, 0.16);
        break;
      case 'close':
        clack(0.09, 0.28, 3000);
        this.playTone(680 * weight, 360 * weight, 0.05, 'triangle', 0.08, 0.015);
        break;
      case 'ready':
        clack(0.105, 0.42, 4200);
        this.playTone(184 * weight, 75, 0.11, 'sine', 0.17);
        break;
    }
  }

  pickup() {
    this.playNoise(0.075, 0.09, 1550);
  }

  hit(crit = false) {
    this.playSample('hit', {
      volume: crit ? 0.42 : 0.28,
      fallback: () => this.playNoise(crit ? 0.085 : 0.048, crit ? 0.13 : 0.065, crit ? 2200 : 1150),
    });
  }

  playerHurt() {
    this.playNoise(0.115, 0.14, 800);
    this.playTone(105, 51, 0.13, 'sine', 0.074);
  }

  playerDown() {
    this.playSample('playerDown', {
      volume: 0.45,
      fallback: () => {
        this.playNoise(0.25, 0.22, 800);
        this.playTone(96, 33, 0.32, 'sine', 0.17);
        this.playNoise(0.1, 0.07, 1500, 0.17);
      },
    });
  }

  playerRespawn() {
    this.playNoise(0.18, 0.095, 1200);
    this.playTone(82, 116, 0.16, 'sine', 0.06);
  }

  soldierDown(volume: number) {
    if (volume <= 0) return;
    this.playNoise(0.19, 0.14 * volume, 1100);
    this.playTone(112, 58, 0.12, 'sine', 0.075 * volume);
  }

  levelUp() {
    this.playTone(440, 440, 0.1, 'triangle', 0.12, 0);
    this.playTone(554, 554, 0.1, 'triangle', 0.12, 0.09);
    this.playTone(659, 880, 0.22, 'triangle', 0.14, 0.18);
  }

  victory() {
    // Triumphant brass/chime fanfare: C5 -> E5 -> G5 -> C6 + warm major chord swell
    this.playTone(523.25, 523.25, 0.14, 'triangle', 0.16, 0);
    this.playTone(659.25, 659.25, 0.14, 'triangle', 0.16, 0.11);
    this.playTone(783.99, 783.99, 0.16, 'triangle', 0.17, 0.22);
    this.playTone(1046.5, 1046.5, 0.55, 'triangle', 0.20, 0.34);
    this.playTone(523.25, 523.25, 0.55, 'sine', 0.12, 0.34);
    this.playTone(659.25, 659.25, 0.55, 'sine', 0.11, 0.34);
    this.playTone(783.99, 783.99, 0.55, 'sine', 0.11, 0.34);
  }

  defeat() {
    // Dramatic descending minor stinger: G4 -> F4 -> Eb4 -> C4 + low resonant bass drop
    this.playTone(392.0, 385.0, 0.20, 'triangle', 0.15, 0);
    this.playTone(349.23, 342.0, 0.20, 'triangle', 0.15, 0.18);
    this.playTone(311.13, 304.0, 0.24, 'triangle', 0.16, 0.36);
    this.playTone(261.63, 246.94, 0.65, 'sawtooth', 0.09, 0.56);
    this.playTone(130.81, 98.0, 0.72, 'sine', 0.18, 0.56);
  }
}

export const sfx = new SoundEngine();
