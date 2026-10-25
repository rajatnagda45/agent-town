/** Raw little-endian PCM16; Live API audio is not a WAV or WebM file. */
export function encodePcm16(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodePcm16(data: string): Float32Array {
  const binary = atob(data);
  if (binary.length % 2) throw new Error("Invalid PCM audio chunk");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

/** Schedule chunks without gaps; discard queued speech immediately on interruption. */
export class VoicePlayback {
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  constructor(private context: AudioContext) {}

  get speaking() {
    return this.sources.size > 0;
  }

  play(data: string, sampleRate = 24000) {
    const samples = decodePcm16(data);
    if (!samples.length) return;
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    const start = Math.max(this.context.currentTime + 0.015, this.nextTime);
    source.start(start);
    this.nextTime = start + buffer.duration;
  }

  stop() {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.nextTime = 0;
  }
}
