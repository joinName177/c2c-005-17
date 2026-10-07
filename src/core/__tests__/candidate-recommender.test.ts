import { describe, expect, it } from 'vitest';
import {
  FRAME_HOP,
  loudestWindow,
  recommendCandidates,
  type AudioProfile,
} from '../candidate-recommender';

const hop = FRAME_HOP;

/** 用若干 [起,止,能量] 段合成帧能量曲线；段外按底噪 0.001 填充 */
function profile(segments: Array<[number, number, number]>, duration?: number): AudioProfile {
  const end = duration ?? Math.max(...segments.map(([, e]) => e));
  const frames = Math.round(end / hop);
  const levels = new Float32Array(frames).fill(0.001);
  for (const [start, stop, gain] of segments) {
    for (let f = Math.round(start / hop); f < Math.round(stop / hop) && f < frames; f += 1) levels[f] = gain;
  }
  return { duration: end, sampleRate: 16000, hop, levels, peaks: [] };
}

describe('recommendCandidates', () => {
  it('全静音：不推荐任何候选，提示手动选段，不产生越界窗口', () => {
    const result = recommendCandidates(profile([], 8));
    expect(result.kind).toBe('silence');
    expect(result.candidates).toHaveLength(0);
    expect(result.message).toContain('手动');
  });

  it('空音频同样按静音处理', () => {
    const result = recommendCandidates({ duration: 0, sampleRate: 16000, hop, levels: new Float32Array(0), peaks: [] });
    expect(result.kind).toBe('silence');
    expect(result.candidates).toHaveLength(0);
  });

  it('短促噪声（磕碰/喷麦）：不推荐，提示重新录制或手动选段', () => {
    const result = recommendCandidates(profile([[3, 3.05, 0.9]], 6));
    expect(result.kind).toBe('noise');
    expect(result.candidates).toHaveLength(0);
    expect(result.message).toMatch(/极短|噪声|磕碰/);
  });

  it('不足十秒的音频：整段保留，不为凑时长拼接静音，候选不超过 3 个且全部 ≤10 秒', () => {
    const result = recommendCandidates(profile([[0.5, 4.5, 0.35]], 6));
    expect(result.kind).toBe('speech');
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThanOrEqual(3);
    const first = result.candidates[0]!;
    expect(first.start).toBeCloseTo(0, 5);
    expect(first.end).toBeCloseTo(6, 5);
    expect(first.reasons.join(' ')).toContain('不足十秒');
    for (const candidate of result.candidates) {
      expect(candidate.end - candidate.start).toBeLessThanOrEqual(10.001);
      expect(candidate.start).toBeGreaterThanOrEqual(0);
      expect(candidate.end).toBeLessThanOrEqual(6.001);
    }
  });

  it('句中长停顿属于同一句：候选整体跨过 0.55 秒停顿，边界落在两侧安静处，并给出停顿理由', () => {
    // 0.3s 前置静音 + 出声 + 0.55s 停顿 + 出声 + 0.3s 尾部静音
    const result = recommendCandidates(profile([[0.3, 2.1, 0.32], [2.65, 4.45, 0.32]], 4.75));
    const full = result.candidates.find((c) => c.start <= 0.35 && c.end >= 4.4);
    expect(full).toBeTruthy();
    expect(full!.stats.longestPause).toBeCloseTo(0.55, 1);
    expect(full!.reasons.join(' ')).toContain('较长停顿');
    expect(full!.reasons.join(' ')).toContain('没有被切断');
  });

  it('长停顿分隔的两句话：推荐成两个互不重叠的候选，绝不跨停顿硬拼十秒', () => {
    const result = recommendCandidates(profile([[1, 3, 0.33], [9.45, 11.45, 0.33]], 14));
    const a = result.candidates.find((c) => c.start < 4);
    const b = result.candidates.find((c) => c.start > 8);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // 没有任何候选跨越中间的 6 秒停顿
    for (const c of result.candidates) expect(c.end - c.start).toBeLessThan(3.2);
    expect(b!.start - a!.end).toBeGreaterThan(5);
  });

  it('连续讲话超过十秒：在能量低谷处切成 ≤10 秒的块，所有候选不越界', () => {
    const segments: Array<[number, number, number]> = [];
    for (let t = 0; t < 24; t += hop) {
      const inDip = t >= 9.7 && t < 10;
      const inSpike = t >= 12 && t < 12.3;
      segments.push([t, Math.min(24, t + hop), inDip ? 0.02 : inSpike ? 0.9 : 0.28]);
    }
    const result = recommendCandidates(profile(segments, 24));
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of result.candidates) {
      expect(c.end - c.start).toBeLessThanOrEqual(10.001);
      expect(c.end).toBeLessThanOrEqual(24.001);
      expect(c.start).toBeGreaterThanOrEqual(0);
    }
    // 切点应靠近 10 秒附近的能量低谷
    const first = result.candidates[0]!;
    expect(Math.abs(first.end - 10)).toBeLessThan(0.35);
  });

  it('排序按分数降序，且最响的一处尖峰不应主导第一名（不只截最响十秒）', () => {
    const segments: Array<[number, number, number]> = [];
    for (let t = 0; t < 24; t += hop) {
      const inDip = t >= 9.7 && t < 10;
      const inSpike = t >= 12 && t < 12.3;
      segments.push([t, Math.min(24, t + hop), inDip ? 0.02 : inSpike ? 0.9 : 0.28]);
    }
    const p = profile(segments, 24);
    const result = recommendCandidates(p);
    for (let i = 1; i < result.candidates.length; i += 1) {
      expect(result.candidates[i - 1]!.score).toBeGreaterThanOrEqual(result.candidates[i]!.score);
    }
    // 朴素“最响十秒”会把尖峰包进去
    const loud = loudestWindow(p);
    expect(loud.start).toBeLessThan(12.3);
    expect(loud.end).toBeGreaterThan(12);
    // 推荐的第一候选完整度高（边界安静），不是追逐尖峰的窗口
    const top = result.candidates[0]!;
    expect(top.stats.edgeQuiet).toBeGreaterThan(0.5);
  });

  it('相近候选去重：同一句话附近不会因为种子扩展不同而出现两张近似卡片', () => {
    // 两句间隔 1.3 秒的话，各自可能产生多个近似窗
    const result = recommendCandidates(profile([[1, 4.5, 0.3], [5.8, 9, 0.3]], 11));
    for (let i = 0; i < result.candidates.length; i += 1) {
      for (let j = i + 1; j < result.candidates.length; j += 1) {
        const a = result.candidates[i]!;
        const b = result.candidates[j]!;
        const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        const shorter = Math.min(a.end - a.start, b.end - b.start);
        expect(overlap / shorter).toBeLessThan(0.6);
      }
    }
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });

  it('推荐理由只描述能量与停顿事实，不出现任何语义/文字识别的说法', () => {
    const result = recommendCandidates(profile([[1, 3, 0.33], [9.45, 11.45, 0.33]], 14));
    const forbidden = ['字', '词', '说的是', '内容为', '语义', '识别出', '意思', '听到“'];
    for (const candidate of result.candidates) {
      for (const reason of candidate.reasons) {
        for (const word of forbidden) expect(reason).not.toContain(word);
      }
    }
  });
});
