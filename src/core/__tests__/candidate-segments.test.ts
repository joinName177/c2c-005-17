import { describe, expect, it } from 'vitest';
import { recommendCandidatesFromAudio } from '../candidate-segments';
import type { DecodedAudio } from '../../adapters/web-audio-cropper.adapter';

const sampleRate = 1000;

function toneAt(sample: number, start: number, end: number, amplitude: number): number {
  const time = sample / sampleRate;
  return time >= start && time < end ? amplitude * Math.sin(sample * 0.4) : 0;
}

function audio(duration: number, voice: (sample: number) => number): DecodedAudio {
  const samples = Float32Array.from({ length: Math.round(duration * sampleRate) }, (_, sample) => voice(sample));
  return { sampleRate, duration, channels: [samples] };
}

describe('recommendCandidatesFromAudio', () => {
  it('keeps the whole source for audio shorter than ten seconds', () => {
    const result = recommendCandidatesFromAudio(audio(6, (sample) => toneAt(sample, 0.5, 5.5, 0.3)));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rank: 1, start: 0, end: 6 });
    expect(result[0]!.reasons.join()).toContain('不足 10 秒');
  });

  it('returns no automatic candidate for silence or one short burst, allowing manual selection', () => {
    expect(recommendCandidatesFromAudio(audio(12, () => 0))).toEqual([]);
    const click = audio(12, (sample) => toneAt(sample, 5, 5.08, 0.9));
    expect(recommendCandidatesFromAudio(click)).toEqual([]);
  });

  it('prefers pause-bounded expressive segments over a separate loud burst', () => {
    const source = audio(16, (sample) => {
      const phraseOne = toneAt(sample, 1.2, 3.8, 0.28);
      const pausePhrase = toneAt(sample, 4.25, 7.25, 0.25);
      const loudBurst = toneAt(sample, 12.2, 12.55, 0.98);
      return Math.max(phraseOne, pausePhrase, loudBurst);
    });
    const result = recommendCandidatesFromAudio(source);
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result[0]!.start).toBeGreaterThanOrEqual(1.1);
    expect(result[0]!.end).toBeLessThanOrEqual(7.5);
    expect(result.some((candidate) => candidate.start >= 12)).toBe(false);
    expect(result[0]!.reasons.join()).toContain('自然停顿');
  });

  it('splits continuous speech longer than ten seconds near energy valleys and deduplicates overlapping windows', () => {
    let value = 0;
    const source = audio(14, (sample) => {
      const time = sample / sampleRate;
      const amplitude = time > 10.2 && time < 10.24 ? 0.04 : 0.38;
      value = amplitude * Math.sin(sample * 0.42);
      return value;
    });
    const result = recommendCandidatesFromAudio(source);
    expect(result).toHaveLength(1);
    expect(result[0]!.end - result[0]!.start).toBeLessThanOrEqual(10);
    expect(result[0]!.reasons.join()).toContain('连续有声段');
  });

  it('limits every recommendation to ten seconds', () => {
    const source = audio(30, (sample) => Math.max(
      toneAt(sample, 2, 9, 0.32),
      toneAt(sample, 14, 22, 0.28),
      toneAt(sample, 25, 29, 0.34),
    ));
    const result = recommendCandidatesFromAudio(source);
    expect(result.length).toBeLessThanOrEqual(3);
    for (const candidate of result) expect(candidate.end - candidate.start).toBeLessThanOrEqual(10);
  });
});
