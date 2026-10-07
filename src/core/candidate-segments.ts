import type { CandidateSegment, CropRange } from './models';

interface CandidateAudio extends CandidateSegment {
  activeDuration: number;
  pauseDuration: number;
  firstActive: number;
  lastActive: number;
  internalPauseCount: number;
  fromContinuousSpan?: boolean;
}

interface ActiveSpan {
  start: number;
  end: number;
}

interface BuildOptions {
  idPrefix?: string;
}

const FRAME_SIZE = 0.02;
const MAX_CLIP = 10;
const GRID = 0.01;
const MIN_ACTIVE_SPAN = 0.16;
const GAP_FILL = 0.3;

export function framePeaks(sampleRate: number, channels: Float32Array[], duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || channels.length === 0) return [];
  const frameCount = Math.max(1, Math.ceil(duration / FRAME_SIZE));
  const peaks = new Array<number>(frameCount).fill(0);
  const frameSamples = Math.max(1, Math.floor(sampleRate * FRAME_SIZE));
  for (let frame = 0; frame < frameCount; frame += 1) {
    const startSample = frame * frameSamples;
    const endSample = Math.min(...channels.map((channel) => channel.length), startSample + frameSamples);
    let peak = 0;
    for (let sample = startSample; sample < endSample; sample += 1) {
      let sum = 0;
      for (const channel of channels) sum += Math.abs(channel[sample] ?? 0);
      peak = Math.max(peak, sum / channels.length);
    }
    peaks[frame] = peak;
  }
  return peaks;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
}

function findActiveSpans(peaks: number[]): ActiveSpan[] {
  if (peaks.length === 0) return [];
  const p50 = percentile(peaks, 0.5);
  const p90 = percentile(peaks, 0.9);
  const threshold = Math.max(0.012, Math.min(0.18, p50 * 2.2, p90 * 0.32));
  const active = peaks.map((peak) => peak >= threshold);
  const fillFrames = Math.round(GAP_FILL / FRAME_SIZE);

  outer: for (let start = 0; start < active.length; start += 1) {
    if (active[start]) continue;
    let end = start;
    while (end < active.length && !active[end]) end += 1;
    if (end - start <= fillFrames && start > 0 && end < active.length && active[start - 1] && active[end]) {
      for (let index = start; index < end; index += 1) active[index] = true;
    }
    start = end;
  }

  const spans: ActiveSpan[] = [];
  for (let start = 0; start < active.length; start += 1) {
    if (!active[start]) continue;
    let end = start;
    while (end < active.length && active[end]) end += 1;
    const spanStart = start * FRAME_SIZE;
    const spanEnd = Math.min(peaks.length * FRAME_SIZE, end * FRAME_SIZE);
    if (spanEnd - spanStart >= MIN_ACTIVE_SPAN) spans.push({ start: spanStart, end: spanEnd });
    start = end;
  }
  return spans;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function scoreCandidate(
  range: CandidateAudio,
  peaks: number[],
  globalPeak: number,
  fromContinuousSpan: boolean | undefined,
): number {
  const startFrame = Math.max(0, Math.floor(range.start / FRAME_SIZE));
  const endFrame = Math.min(peaks.length, Math.ceil(range.end / FRAME_SIZE));
  const values = peaks.slice(startFrame, endFrame);
  if (values.length === 0) return 0;
  const duration = range.end - range.start;
  const activeRatio = Math.min(1, range.activeDuration / Math.max(MIN_ACTIVE_SPAN, duration));
  const pauseRatio = range.pauseDuration / Math.max(0.001, duration);
  const activeValues = values.filter((value) => value > 0.01);
  const representative = median(activeValues.length ? activeValues : values);
  const energy = globalPeak > 0 ? Math.min(1, representative / globalPeak) : 0;
  const p10 = percentile(activeValues.length ? activeValues : values, 0.1);
  const p90 = percentile(activeValues.length ? activeValues : values, 0.9);
  const dynamics = p10 > 0 ? Math.min(1, (p90 - p10) / Math.max(0.001, p10) / 3) : Math.min(1, p90);

  if (fromContinuousSpan) {
    const edgeStart = values.slice(0, 5).reduce((sum, value) => sum + value, 0) / Math.max(1, Math.min(5, values.length));
    const edgeEnd = values.slice(-5).reduce((sum, value) => sum + value, 0) / Math.max(1, Math.min(5, values.length));
    const edgeValley = globalPeak > 0 ? 1 - Math.min(1, (edgeStart + edgeEnd) / (2 * globalPeak)) : 0;
    const lengthScore = duration >= 1 ? 1 : duration / 1;
    return Math.max(0, energy * 0.28 + dynamics * 0.18 + edgeValley * 0.34 + lengthScore * 0.2);
  }

  const leadingPause = range.activeDuration > 0 ? range.firstActive - range.start : 0;
  const trailingPause = range.activeDuration > 0 ? range.end - range.lastActive : 0;
  const boundaryScore = Math.min(1, (leadingPause + trailingPause) / 0.28);
  const activeLengthScore = Math.min(1, range.activeDuration / 2.2);
  const sustainedScore = Math.min(1, range.activeDuration / 0.75);
  const pauseScore = pauseRatio <= 0.36 ? 1 : Math.max(0.35, 1 - (pauseRatio - 0.36) / 0.44);
  const multiSpanScore = Math.min(1, range.internalPauseCount * 0.24);
  const score = energy * 0.16 + dynamics * 0.1 + activeRatio * 0.18 + activeLengthScore * 0.18 + boundaryScore * 0.17 + pauseScore * 0.07 + sustainedScore * 0.08 + multiSpanScore * 0.06;
  const shortNoisePenalty = range.activeDuration < 0.6 ? Math.max(0.12, range.activeDuration / 0.6) : 1;
  return Math.max(0, score * shortNoisePenalty);
}

function buildCandidate(range: CropRange, spans: ActiveSpan[], peaks: number[], globalPeak: number, fromContinuousSpan = false): CandidateAudio {
  const contained = spans.filter((span) => span.end > range.start && span.start < range.end);
  const activeParts = contained.map((span) => Math.max(0, Math.min(span.end, range.end) - Math.max(span.start, range.start)));
  const activeDuration = activeParts.reduce((sum, value) => sum + value, 0);
  const firstActive = contained.length ? Math.max(range.start, contained[0]!.start) : range.start;
  const lastActive = contained.length ? Math.min(range.end, contained[contained.length - 1]!.end) : range.end;
  return {
    ...range,
    id: '',
    rank: 0,
    score: 0,
    reasons: [],
    activeDuration,
    pauseDuration: Math.max(0, range.end - range.start - activeDuration),
    firstActive,
    lastActive,
    internalPauseCount: Math.max(0, contained.length - 1),
    fromContinuousSpan,
  };
}

function snapRange(start: number, end: number, duration: number): CropRange | undefined {
  const snappedStart = Math.max(0, Math.round(start / GRID) * GRID);
  let snappedEnd = Math.min(duration, Math.round(end / GRID) * GRID);
  if (snappedEnd <= snappedStart || snappedEnd > duration + GRID) return undefined;
  if (snappedEnd - snappedStart > MAX_CLIP) {
    const shortenedEnd = Number((snappedStart + MAX_CLIP).toFixed(2));
    if (end - start > MAX_CLIP + GRID || shortenedEnd > duration + GRID) return undefined;
    snappedEnd = shortenedEnd;
  }
  return { start: Number(snappedStart.toFixed(2)), end: Number(snappedEnd.toFixed(2)) };
}

function continuousWindows(span: ActiveSpan, duration: number, peaks: number[], globalPeak: number): CandidateAudio[] {
  const spanDuration = span.end - span.start;
  if (spanDuration <= MAX_CLIP) return [];
  const windows: CandidateAudio[] = [];
  const length = Math.min(MAX_CLIP - 0.02, spanDuration);
  const step = 0.1;
  for (let rawStart = span.start; rawStart + length <= span.end + 0.001; rawStart += step) {
    const range = snapRange(rawStart, rawStart + length, duration);
    if (!range || range.end - range.start < Math.min(1, spanDuration)) continue;
    windows.push(buildCandidate(range, [span], peaks, globalPeak, true));
  }
  const lastStart = Math.max(span.start, span.end - length);
  const lastRange = snapRange(lastStart, span.end, duration);
  if (lastRange) windows.push(buildCandidate(lastRange, [span], peaks, globalPeak, true));
  return windows;
}

function groupedCandidates(spans: ActiveSpan[], duration: number, peaks: number[], globalPeak: number): CandidateAudio[] {
  const candidates: CandidateAudio[] = [];
  for (let first = 0; first < spans.length; first += 1) {
    for (let last = first; last < spans.length; last += 1) {
      const range = snapRange(spans[first]!.start, spans[last]!.end, duration);
      if (!range) continue;
      candidates.push(buildCandidate(range, spans.slice(first, last + 1), peaks, globalPeak));
    }
  }
  return candidates;
}

function reasonsFor(candidate: CandidateAudio, spans: ActiveSpan[], duration: number): string[] {
  const reasons: string[] = [];
  const length = candidate.end - candidate.start;
  const pauseRatio = candidate.pauseDuration / Math.max(0.001, length);
  const contained = spans.filter((span) => span.end > candidate.start && span.start < candidate.end);

  if (duration <= MAX_CLIP && Math.abs(candidate.start) < GRID && Math.abs(candidate.end - duration) < GRID * 2) {
    reasons.push(duration < MAX_CLIP ? '整段音频不足 10 秒，直接保留全部声音。' : '整段音频不超过 10 秒，边界从音频首尾取齐。');
  } else if (candidate.fromContinuousSpan) {
    reasons.push('连续有声段超过 10 秒，按局部声音起伏选边界，避免只截一个最高峰值。');
  } else {
    if (candidate.start > GRID) reasons.push('起点前有明显低能量间隔。');
    if (duration - candidate.end > GRID) reasons.push('终点后有明显低能量间隔。');
    if (contained.length > 1) reasons.push(`保留了 ${contained.length} 段声音之间的自然停顿。`);
    else if (pauseRatio < 0.08) reasons.push('片段内部连续，没有被长停顿拆开。');
  }

  if (candidate.activeDuration >= 0.16) reasons.push(`有效声音约 ${candidate.activeDuration.toFixed(1)} 秒，静音约占 ${Math.round(pauseRatio * 100)}%。`);
  if (reasons.length === 1) reasons.push('排序综合了声音能量、动态变化和边界停顿，而不是单独取最响片段。');
  return reasons.slice(0, 3);
}

function similar(a: CandidateAudio, b: CandidateAudio): boolean {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return overlap / Math.max(0.001, union) > 0.62 || overlap / Math.max(0.001, shorter) > 0.9 || overlap >= 5;
}

export function recommendCandidatesFromAudio(audio: { sampleRate: number; duration: number; channels: Float32Array[] }, options: BuildOptions = {}): CandidateSegment[] {
  const duration = Math.max(0, audio.duration);
  if (duration <= 0 || audio.channels.length === 0 || audio.channels.every((channel) => channel.length === 0)) return [];
  if (duration <= MAX_CLIP) {
    const candidate = buildCandidate({ start: 0, end: duration }, [], framePeaks(audio.sampleRate, audio.channels, duration), 0);
    candidate.score = 1;
    candidate.reasons = reasonsFor(candidate, [], duration);
    return [{ id: `${options.idPrefix ?? 'candidate'}-full`, rank: 1, start: 0, end: duration, score: 1, reasons: candidate.reasons }];
  }

  const peaks = framePeaks(audio.sampleRate, audio.channels, duration);
  const spans = findActiveSpans(peaks);
  if (spans.length === 0) return [];
  const globalPeak = percentile(peaks, 0.98) || Math.max(...peaks);
  const candidates = [...groupedCandidates(spans, duration, peaks, globalPeak)];
  for (const span of spans) candidates.push(...continuousWindows(span, duration, peaks, globalPeak));

  const scored = candidates
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, peaks, globalPeak, candidate.fromContinuousSpan) }))
    .filter((candidate) => candidate.activeDuration >= MIN_ACTIVE_SPAN && candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.activeDuration - a.activeDuration || a.start - b.start);

  const selected: CandidateAudio[] = [];
  for (const candidate of scored) {
    if (selected.every((existing) => !similar(existing, candidate))) selected.push(candidate);
    if (selected.length === 3) break;
  }

  return selected.map((candidate, index) => ({
      id: `${options.idPrefix ?? 'candidate'}-${index + 1}`,
      rank: index + 1,
      start: candidate.start,
      end: candidate.end,
      score: Number(candidate.score.toFixed(3)),
      reasons: reasonsFor(candidate, spans, duration),
    }));
}
