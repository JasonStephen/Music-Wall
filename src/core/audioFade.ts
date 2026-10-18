/** Independent envelope and user volume, with a media-volume fallback. */
export class AudioFader {
  private context: AudioContext | null = null;
  private states = new Map<HTMLAudioElement, { gain: GainNode | null; source: MediaElementAudioSourceNode | null; value: number; ramp?: { from: number; target: number; start: number; duration: number }; cancel?: () => void }>();
  private volume = 1;
  constructor(private webAudio = true) {}
  attach(media: HTMLAudioElement, value = 1): void {
    let gain: GainNode | null = null, source: MediaElementAudioSourceNode | null = null;
    try {
      if (this.webAudio && typeof AudioContext !== "undefined" && typeof HTMLMediaElement !== "undefined" && media instanceof HTMLMediaElement) {
        this.context ??= new AudioContext(); source = this.context.createMediaElementSource(media); gain = this.context.createGain();
        source.connect(gain); gain.connect(this.context.destination); media.volume = 1;
      }
    } catch { gain = null; source = null; }
    this.states.set(media, { gain, source, value }); this.paint(media);
    void this.resume();
  }
  async resume(): Promise<void> { if (this.context?.state === "suspended") try { await this.context.resume(); } catch {} }
  setVolume(volume: number): void { this.volume = volume; for (const media of this.states.keys()) this.paint(media); }
  private paint(media: HTMLAudioElement): void {
    const state = this.states.get(media); if (!state) return;
    const fraction = state.ramp ? Math.min(1, (performance.now() - state.ramp.start) / state.ramp.duration) : 1;
    const value = state.ramp ? state.ramp.from + (state.ramp.target - state.ramp.from) * fraction : state.value;
    if (state.gain && this.context) {
      const now = this.context.currentTime, gain = state.gain.gain;
      gain.cancelScheduledValues(now); gain.setValueAtTime(value * this.volume, now);
      if (state.ramp && fraction < 1) gain.linearRampToValueAtTime(state.ramp.target * this.volume, now + state.ramp.duration * (1 - fraction) / 1000);
    }
    else media.volume = value * this.volume;
  }
  fade(media: HTMLAudioElement, target: number, seconds: number): Promise<boolean> {
    const state = this.states.get(media); if (!state) return Promise.resolve(false);
    state.cancel?.();
    if (!seconds || state.value === target) { state.value = target; this.paint(media); return Promise.resolve(true); }
    const start = performance.now(), from = state.value, duration = Math.max(0, Math.min(6, seconds)) * 1000;
    state.ramp = { from, target, start, duration }; this.paint(media);
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      state.cancel = () => {
        clearTimeout(timer); state.value = from + (target - from) * Math.min(1, (performance.now() - start) / duration);
        state.ramp = undefined; state.cancel = undefined; this.paint(media); resolve(false);
      };
      const step = () => {
        const fraction = Math.min(1, (performance.now() - start) / duration);
        if (!state.gain) this.paint(media);
        if (fraction < 1) timer = setTimeout(step, state.gain ? Math.max(1, duration * (1 - fraction)) : 16);
        else { state.value = target; state.ramp = undefined; state.cancel = undefined; this.paint(media); resolve(true); }
      };
      step();
    });
  }
  release(media: HTMLAudioElement): void {
    const state = this.states.get(media); if (!state) return;
    state.cancel?.(); state.source?.disconnect(); state.gain?.disconnect(); this.states.delete(media);
  }
  close(): void { for (const media of [...this.states.keys()]) this.release(media); void this.context?.close().catch(() => {}); this.context = null; }
}
