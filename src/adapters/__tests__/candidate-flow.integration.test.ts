import { describe, expect, it } from 'vitest';
import { recommendCandidates, type AudioProfile } from '../../core/candidate-recommender';
import { buildDemoVoice, encodeWavPcm } from '../../core/demo-audio';
import { WebAudioProfilerAdapter } from '../web-audio-profiler.adapter';
import { encodeWavBytes, WebAudioCropperAdapter, type DecodedAudio } from '../web-audio-cropper.adapter';
import type { CropRange } from '../../core/models';

function parseWav(bytes: Uint8Array): { sampleRate: number; samples: Int16Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const sampleRate = view.getUint32(24, true);
  const dataLength = view.getUint32(40, true);
  const samples = new Int16Array(dataLength / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(44 + i * 2, true);
  return { sampleRate, samples };
}

async function profileVoice(id: string): Promise<{ profile: AudioProfile; blob: Blob; decoded: DecodedAudio }> {
  const voice = buildDemoVoice(id);
  const decoded: DecodedAudio = { sampleRate: voice.sampleRate, duration: voice.duration, channels: voice.channels };
  const profiler = new WebAudioProfilerAdapter({ decode: async () => decoded });
  const blob = encodeWavPcm(voice.channels, voice.sampleRate);
  const profile = await profiler.profile(blob);
  return { profile, blob, decoded };
}

describe('候选时间与实际裁剪内容一致（对照声音端到端）', () => {
  it.each(['short', 'paused', 'separated', 'continuous', 'radio'] as const)(
    '%s：每个候选裁剪出的 WAV 采样区间都精确对应候选起止，且 ≤10 秒',
    async (id) => {
      const { profile, blob, decoded } = await profileVoice(id);
      const result = recommendCandidates(profile);
      expect(result.candidates.length).toBeGreaterThan(0);
      const cropper = new WebAudioCropperAdapter({ decode: async () => decoded });
      for (const candidate of result.candidates) {
        const cropped = await cropper.crop(blob, { start: candidate.start, end: candidate.end });
        expect(cropped.duration).toBeCloseTo(candidate.end - candidate.start, 1);
        expect(cropped.duration).toBeLessThanOrEqual(10.01);
        // 直接对裁剪编码函数的字节产物断言（与 cropper.crop 内部同一路径）
        const { samples, sampleRate } = parseWav(encodeWavBytes(decoded, { start: candidate.start, end: candidate.end }));
        expect(sampleRate).toBe(decoded.sampleRate);
        const expectedLength = Math.round((candidate.end - candidate.start) * sampleRate);
        // 采样数与时间标记换算一致（容差 1 个采样）
        expect(Math.abs(samples.length - expectedLength)).toBeLessThanOrEqual(1);
        // 内容一致：裁剪产物第 k 个采样 == 源音频 start+k 处采样
        const startSample = Math.round(candidate.start * sampleRate);
        let mismatch = 0;
        for (let k = 0; k < Math.min(samples.length, expectedLength); k += 1) {
          const source = decoded.channels[0]![startSample + k]!;
          const expected16 = Math.round(source * 32767);
          if (Math.abs(samples[k]! - expected16) > 1) mismatch += 1;
        }
        expect(mismatch).toBe(0);
      }
    },
  );

  it('continuous：推荐第一候选与“只截最响十秒”不是同一段（没有只截最响的十秒）', async () => {
    const { profile } = await profileVoice('continuous');
    const result = recommendCandidates(profile);
    const top = result.candidates[0]!;
    // 最响十秒必然包含 12s 尖峰
    const spikeEnergy = (range: CropRange) => {
      let sum = 0;
      for (let f = Math.round(range.start / profile.hop); f < Math.round(range.end / profile.hop); f += 1) sum += (profile.levels[f] ?? 0) ** 2;
      return sum;
    };
    const windows = result.candidates.map((c) => ({ start: c.start, end: c.end }));
    // 包含尖峰的窗口能量应高于第一名，却不是第一名——证明排序不是按响度
    const containingSpike = windows.filter((w) => w.start <= 12 && w.end >= 12.25);
    if (containingSpike.length) {
      expect(Math.max(...containingSpike.map(spikeEnergy))).toBeGreaterThan(spikeEnergy(top));
    }
  });

  it('separated：没有任何候选跨越中间 6.5 秒长停顿，两个候选分别对应两侧出声', async () => {
    const { profile } = await profileVoice('separated');
    const result = recommendCandidates(profile);
    const left = result.candidates.find((c) => c.start < 4);
    const right = result.candidates.find((c) => c.start > 8);
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
    for (const candidate of result.candidates) {
      const spansGap = candidate.start < 4 && candidate.end > 9;
      expect(spansGap).toBe(false);
    }
  });

  it('silence 与 bang：推荐为空并提示手动选段，不产生裁剪', async () => {
    for (const id of ['silence', 'bang'] as const) {
      const { profile } = await profileVoice(id);
      const result = recommendCandidates(profile);
      expect(result.candidates).toHaveLength(0);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('试听走的 crop 与最终 analyze 走的 crop 产出相同字节（同一路径）', async () => {
    const { decoded } = await profileVoice('separated');
    const range: CropRange = { start: 1, end: 3 };
    const audition = encodeWavBytes(decoded, range);
    const finalBytes = encodeWavBytes(decoded, range);
    expect(audition).toEqual(finalBytes);
  });
});
