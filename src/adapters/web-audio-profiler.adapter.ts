import { FRAME_HOP, type AudioProfile } from '../core/candidate-recommender';
import type { AudioProfilerPort } from '../ports/audio-profiler.port';
import type { DecodedAudio } from './web-audio-cropper.adapter';

interface Dependencies { decode(blob: Blob): Promise<DecodedAudio> }
async function browserDecode(blob: Blob): Promise<DecodedAudio> {
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const mono = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    mono[i] = channels.length ? sum / channels.length : 0;
  }
  await context.close();
  return { sampleRate: buffer.sampleRate, duration: buffer.duration, channels: [mono] };
}

/** 25ms 帧长内的 RMS；帧移同样 25ms（无重叠），边界统计已足够稳定 */
function frameLevels(samples: Float32Array, sampleRate: number, hop: number): Float32Array {
  const frameSize = Math.max(1, Math.round(hop * sampleRate));
  const count = Math.max(1, Math.ceil(samples.length / frameSize));
  const levels = new Float32Array(count);
  for (let frame = 0; frame < count; frame += 1) {
    const from = frame * frameSize;
    const to = Math.min(samples.length, from + frameSize);
    let sumSq = 0;
    for (let i = from; i < to; i += 1) sumSq += (samples[i] ?? 0) ** 2;
    levels[frame] = to > from ? Math.sqrt(sumSq / (to - from)) : 0;
  }
  return levels;
}

/** 降采样峰值，供时间线绘制，最多 ~240 条 */
function buildPeaks(levels: Float32Array): number[] {
  const buckets = Math.min(240, levels.length);
  const peaks: number[] = [];
  const per = levels.length / buckets;
  for (let b = 0; b < buckets; b += 1) {
    let peak = 0;
    const from = Math.floor(b * per);
    const to = Math.min(levels.length, Math.ceil((b + 1) * per));
    for (let i = from; i < to; i += 1) peak = Math.max(peak, levels[i] ?? 0);
    peaks.push(peak);
  }
  return peaks;
}

export class WebAudioProfilerAdapter implements AudioProfilerPort {
  constructor(private readonly deps: Dependencies = { decode: browserDecode }) {}
  async profile(blob: Blob): Promise<AudioProfile> {
    const audio = await this.deps.decode(blob);
    const samples = audio.channels[0] ?? new Float32Array();
    const hop = FRAME_HOP;
    const levels = frameLevels(samples, audio.sampleRate, hop);
    return { duration: audio.duration, sampleRate: audio.sampleRate, hop, levels, peaks: buildPeaks(levels) };
  }
}
