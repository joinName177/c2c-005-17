import { describe, expect, it } from 'vitest';
import { WebAudioProfilerAdapter } from '../web-audio-profiler.adapter';
import type { DecodedAudio } from '../web-audio-cropper.adapter';
import { FRAME_HOP } from '../../core/candidate-recommender';

function sineBurstAudio(duration: number, gain: number, frequency: number): DecodedAudio {
  const sampleRate = 1000;
  const length = Math.round(duration * sampleRate);
  const channel = new Float32Array(length);
  for (let i = 0; i < length; i += 1) channel[i] = gain * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return { sampleRate, duration, channels: [channel] };
}

describe('WebAudioProfilerAdapter', () => {
  it('按帧产出有限的能量曲线，帧能量随信号增益单调变化', async () => {
    const loud = new WebAudioProfilerAdapter({ decode: async () => sineBurstAudio(1, 0.6, 100) }).profile(new Blob());
    const quiet = new WebAudioProfilerAdapter({ decode: async () => sineBurstAudio(1, 0.05, 100) }).profile(new Blob());
    const [a, b] = await Promise.all([loud, quiet]);
    expect(a.levels.length).toBe(Math.round(1 / FRAME_HOP));
    expect(a.levels.every(Number.isFinite)).toBe(true);
    expect(a.peaks.length).toBeGreaterThan(0);
    const mean = (arr: Float32Array) => arr.reduce((sum, v) => sum + v, 0) / arr.length;
    expect(mean(a.levels)).toBeGreaterThan(mean(b.levels) * 4);
  });

  it('全静音输入能量为 0，不抛异常', async () => {
    const adapter = new WebAudioProfilerAdapter({ decode: async () => ({ sampleRate: 1000, duration: 1, channels: [new Float32Array(1000)] }) });
    const profile = await adapter.profile(new Blob());
    expect(profile.levels.every((v) => v === 0)).toBe(true);
    expect(profile.duration).toBe(1);
  });
});
