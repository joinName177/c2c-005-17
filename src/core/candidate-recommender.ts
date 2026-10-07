import type { CropRange } from './models';

/**
 * 候选片段推荐（纯声学、纯函数）。
 *
 * 输入只有帧能量曲线，不接触任何语义信息：
 * 推荐理由也只能引用这里算出的能量/停顿事实，不能出现“说了什么”。
 */

export const MAX_CLIP_SECONDS = 10;
/** 帧移：每 25ms 一个 RMS 能量帧 */
export const FRAME_HOP = 0.025;
/** 句内换气级短停顿上限：不超过它的停顿会被桥接，不切断表达 */
export const BRIDGE_GAP_SECONDS = 0.18;
/** 算作一句完整出声的最短时长；更短的连通声段视为短促噪声 */
export const MIN_SPEECH_SECONDS = 0.3;
/** 允许跨越长停顿合并两侧语音时，语音占窗口的最低比例 */
export const LONG_PAUSE_MERGE_DENSITY = 0.45;
/** 允许桥接的最长句内停顿；再长的停顿视为语句边界，不跨句拼接 */
export const MAX_INTRA_SENTENCE_GAP = 1;

export interface AudioProfile {
  duration: number;
  sampleRate: number;
  hop: number;
  /** 每帧线性 RMS 能量（0~1） */
  levels: Float32Array;
  /** 供时间线绘制的降采样峰值（0~1） */
  peaks: number[];
}

export interface CandidateStats {
  /** 窗口内出声时长（秒） */
  speechDuration: number;
  /** 窗口内被完整保留的最长一次内部停顿（秒） */
  longestPause: number;
  /** 窗口出声比例 0~1 */
  voicedRatio: number;
  /** 起止边缘安静度 0~1，越高表示越没有切断语句 */
  edgeQuiet: number;
  /** 窗口内孤立短促噪声帧占比 0~1 */
  noiseFraction: number;
}

export interface SegmentCandidate {
  start: number;
  end: number;
  score: number;
  reasons: string[];
  stats: CandidateStats;
}

export type RecommendationKind = 'speech' | 'silence' | 'noise';

export interface CandidateRecommendation {
  kind: RecommendationKind;
  /** 按分排序、相近去重后，最多 3 个 */
  candidates: SegmentCandidate[];
  /** 无候选时给用户的手动选段提示 */
  message: string;
  /** 自适应能量门限，测试与排查用 */
  gate: number;
}

interface Run { startFrame: number; endFrame: number; speech: boolean }
interface WindowFrames { startFrame: number; endFrame: number }

function quantile(sortedAsc: Float32Array | number[], q: number): number {
  if (!sortedAsc.length) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAsc[Math.min(base + 1, sortedAsc.length - 1)] ?? sortedAsc[base];
  return (sortedAsc[base] ?? 0) * (1 - rest) + next * rest;
}

/** 自适应门限：低分位估底噪、高分位估稳定响度，避免单处爆音抬高门限 */
export function resolveGate(levels: Float32Array): { gate: number; floor: number; ceiling: number; active: boolean } {
  if (!levels.length) return { gate: 1, floor: 0, ceiling: 0, active: false };
  const sorted = Float32Array.from(levels).sort();
  const floor = quantile(sorted, 0.2);
  const ceiling = quantile(sorted, 0.9);
  let max = 0;
  for (const value of levels) max = Math.max(max, value);
  // 整段几乎没有可闻能量（全静音 / 只有极低底噪）；用 max 判定，
  // 这样静音中的一声磕碰仍会被检测到并落到“短促噪声”分支
  if (max < 0.012) return { gate: 1, floor, ceiling, active: false };
  // 门限靠近底噪一侧：连续讲话时帧能量起伏小也不会被误判成静音
  const gate = Math.max(0.012, floor * 0.85 + ceiling * 0.15);
  return { gate, floor, ceiling, active: true };
}

/** 出声掩码 + 短停顿桥接：句中换气不切断，长停顿保留为边界线索 */
function extractRuns(levels: Float32Array, gate: number, hop: number): Run[] {
  const voiced = new Array<boolean>(levels.length).fill(false);
  for (let i = 0; i < levels.length; i += 1) voiced[i] = levels[i] >= gate;
  const bridge = Math.floor(BRIDGE_GAP_SECONDS / hop);
  for (let i = 0; i < levels.length; i += 1) {
    if (voiced[i]) continue;
    let j = i;
    while (j < levels.length && !voiced[j]) j += 1;
    const gap = j - i;
    if (i > 0 && j < levels.length && gap <= bridge) for (let k = i; k < j; k += 1) voiced[k] = true;
    i = j - 1;
  }
  const runs: Run[] = [];
  for (let i = 0; i < voiced.length; i += 1) {
    if (!voiced[i]) continue;
    const start = i;
    while (i < voiced.length && voiced[i]) i += 1;
    const end = i;
    runs.push({ startFrame: start, endFrame: end, speech: (end - start) * hop >= MIN_SPEECH_SECONDS });
  }
  return runs;
}

function spanSeconds(a: number, b: number, hop: number): number {
  return (b - a) * hop;
}

/**
 * 以每个语音段为种子贪心向两侧扩展：
 * - 小停顿直接并入；
 * - 长停顿只有在两侧语音密度仍够（像一句话中间的停顿）时才跨过，
 *   绝不把两句互不相干的话硬拼成十秒；
 * - 总跨度始终 ≤ 10 秒。
 */
function buildSeedWindows(runs: Run[], hop: number): WindowFrames[] {
  const speechRuns = runs.filter((run) => run.speech);
  const windows: WindowFrames[] = [];
  for (let seed = 0; seed < speechRuns.length; seed += 1) {
    let lo = seed;
    let hi = seed;
    // 可并入的前提：跨度 ≤10s、跨过的停顿不超过句内停顿上限、语音密度仍然够
    const feasible = (left: number, right: number): boolean => {
      if (spanSeconds(speechRuns[left].startFrame, speechRuns[right].endFrame, hop) > MAX_CLIP_SECONDS) return false;
      for (let k = left; k < right; k += 1) {
        if (spanSeconds(speechRuns[k].endFrame, speechRuns[k + 1].startFrame, hop) > MAX_INTRA_SENTENCE_GAP) return false;
      }
      let speech = 0;
      for (let k = left; k <= right; k += 1) speech += spanSeconds(speechRuns[k].startFrame, speechRuns[k].endFrame, hop);
      const span = spanSeconds(speechRuns[left].startFrame, speechRuns[right].endFrame, hop);
      if (speech / span < LONG_PAUSE_MERGE_DENSITY) return false;
      return true;
    };
    let changed = true;
    while (changed) {
      changed = false;
      const gapLeft = lo > 0 ? speechRuns[lo].startFrame - speechRuns[lo - 1].endFrame : Infinity;
      const gapRight = hi < speechRuns.length - 1 ? speechRuns[hi + 1].startFrame - speechRuns[hi].endFrame : Infinity;
      if (gapLeft <= gapRight && lo > 0 && feasible(lo - 1, hi)) { lo -= 1; changed = true; }
      else if (hi < speechRuns.length - 1 && feasible(lo, hi + 1)) { hi += 1; changed = true; }
      else if (lo > 0 && feasible(lo - 1, hi)) { lo -= 1; changed = true; }
    }
    windows.push({ startFrame: speechRuns[lo].startFrame, endFrame: speechRuns[hi].endFrame });
  }
  return windows;
}

/**
 * 连续讲话超过 10 秒：按十秒切块，切点选在局部能量最低的位置
 * （句内换气点），而不是生硬地按整数秒切。
 */
function splitLongRun(run: Run, levels: Float32Array, hop: number): WindowFrames[] {
  const maxFrames = Math.round(MAX_CLIP_SECONDS / hop);
  if (run.endFrame - run.startFrame <= maxFrames) return [{ startFrame: run.startFrame, endFrame: run.endFrame }];
  const searchBack = Math.round(0.25 / hop);
  const chunks: WindowFrames[] = [];
  let start = run.startFrame;
  while (run.endFrame - start > maxFrames) {
    let end = start + maxFrames;
    let best = end;
    let bestLevel = Infinity;
    for (let f = end - searchBack; f <= end; f += 1) {
      if (f < start || f >= levels.length) continue;
      if ((levels[f] ?? 1) < bestLevel) { bestLevel = levels[f] ?? 1; best = f; }
    }
    end = best;
    chunks.push({ startFrame: start, endFrame: end });
    start = end;
  }
  chunks.push({ startFrame: start, endFrame: run.endFrame });
  // 尾部残段过短则并入上一块（合并不超过十秒）
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (spanSeconds(last.startFrame, last.endFrame, hop) < 1.5 && last.endFrame - prev.startFrame <= maxFrames) {
      prev.endFrame = last.endFrame;
      chunks.pop();
    }
  }
  return chunks;
}

/** 边界对齐：把边缘外的安静留白吃进来（停顿处下刀），但不把跨度撑过十秒 */
function alignEdges(win: WindowFrames, runs: Run[], frameCount: number, hop: number): WindowFrames {
  const maxFrames = Math.round(MAX_CLIP_SECONDS / hop);
  let { startFrame, endFrame } = win;
  const insideSpeech = (frame: number): boolean =>
    runs.some((run) => run.speech && frame >= run.startFrame && frame < run.endFrame);
  const pad = Math.round(0.12 / hop);
  if (startFrame > 0 && !insideSpeech(startFrame - 1)) {
    let add = 0;
    while (add < pad && startFrame - 1 > 0 && !insideSpeech(startFrame - 1)) { startFrame -= 1; add += 1; }
  }
  if (endFrame < frameCount && !insideSpeech(endFrame)) {
    let add = 0;
    while (add < pad && endFrame < frameCount && !insideSpeech(endFrame)) { endFrame += 1; add += 1; }
  }
  // 外扩后超十秒时，从两侧安静边距轮流收回
  let fromLeft = true;
  while (endFrame - startFrame > maxFrames) {
    if (fromLeft && !insideSpeech(startFrame)) startFrame += 1;
    else if (!insideSpeech(endFrame - 1)) endFrame -= 1;
    else if (fromLeft) startFrame += 1;
    else endFrame -= 1;
    fromLeft = !fromLeft;
  }
  return { startFrame: Math.max(0, startFrame), endFrame: Math.min(frameCount, endFrame) };
}

interface ScoredWindow extends WindowFrames {
  score: number;
  stats: CandidateStats;
}

function scoreWindow(
  win: WindowFrames,
  levels: Float32Array,
  runs: Run[],
  gate: number,
  ceiling: number,
  hop: number,
  frameCount: number,
): ScoredWindow {
  const spanFrames = win.endFrame - win.startFrame;
  let speechFrames = 0;
  let speechLevelSum = 0;
  for (let f = win.startFrame; f < win.endFrame; f += 1) {
    const inSpeech = runs.some((run) => run.speech && f >= run.startFrame && f < run.endFrame);
    if (inSpeech) { speechFrames += 1; speechLevelSum += levels[f] ?? 0; }
  }
  let noiseFrames = 0;
  for (const run of runs) {
    if (run.speech) continue;
    const overlap = Math.min(run.endFrame, win.endFrame) - Math.max(run.startFrame, win.startFrame);
    if (overlap > 0) noiseFrames += overlap;
  }
  // 窗口内最长内部停顿（两侧都还有出声）
  let longestPause = 0;
  const inside = runs.filter((r) => r.speech && r.endFrame > win.startFrame && r.startFrame < win.endFrame);
  for (let k = 1; k < inside.length; k += 1) {
    longestPause = Math.max(longestPause, (inside[k].startFrame - inside[k - 1].endFrame) * hop);
  }
  const span = spanFrames * hop;
  const speechDuration = speechFrames * hop;
  const voicedRatio = spanFrames ? speechFrames / spanFrames : 0;
  const meanSpeechLevel = speechFrames ? speechLevelSum / speechFrames : 0;
  const coverage = 0.5 + 0.5 * (ceiling ? meanSpeechLevel / ceiling : 0);
  // 边缘能量低于门限=刀落在停顿里；切在语音中央则趋近 0。
  // 位于音频物理端点（0 / 结尾）的边缘不可能切断任何声音，按安全处理。
  const edgeCount = Math.max(1, Math.round(0.06 / hop));
  let edgePenalty = 0;
  let edgeSides = 0;
  if (win.startFrame > 0) {
    let sum = 0; let used = 0;
    for (let f = win.startFrame; f < Math.min(win.endFrame, win.startFrame + edgeCount); f += 1) { sum += levels[f] ?? 0; used += 1; }
    edgePenalty += used ? sum / used / gate : 0; edgeSides += 1;
  }
  if (win.endFrame < frameCount) {
    let sum = 0; let used = 0;
    for (let f = Math.max(win.startFrame, win.endFrame - edgeCount); f < win.endFrame; f += 1) { sum += levels[f] ?? 0; used += 1; }
    edgePenalty += used ? sum / used / gate : 0; edgeSides += 1;
  }
  const edgeQuiet = edgeSides ? Math.max(0, 1 - edgePenalty / edgeSides) : 1;
  // 长度奖励偏向“接近十秒的完整窗口”，但不奖励超过十秒；
  // 单独一句短反应在没有更长选择时仍能胜出
  const spanSec = spanFrames * hop;
  const lengthFit = spanSec >= MAX_CLIP_SECONDS ? 1 : Math.max(0, Math.min(1, spanSec / MAX_CLIP_SECONDS));
  const noiseFraction = spanFrames ? noiseFrames / spanFrames : 0;
  // 响度只占 16%，且是相对自身峰值；完整边界（edgeQuiet）与出声密度占大头
  let score = 0.34 * voicedRatio + 0.16 * coverage + 0.28 * edgeQuiet + 0.22 * lengthFit;
  score *= 1 - Math.min(0.5, noiseFraction * 2);
  score = Math.max(0, Math.min(1, score));
  return {
    ...win,
    score,
    stats: { speechDuration, longestPause, voicedRatio, edgeQuiet, noiseFraction },
  };
}

function reasonsFor(win: ScoredWindow, duration: number, span: number): string[] {
  const reasons: string[] = [];
  const { stats } = win;
  if (duration <= MAX_CLIP_SECONDS + 0.05) reasons.push('整段音频不足十秒，已全部保留，未额外拼接静音');
  if (stats.edgeQuiet >= 0.6) reasons.push('起止位置都在能量明显回落处或音频端点，出声段的开头和结尾没有被切断');
  if (stats.longestPause >= 0.45) reasons.push(`中间有一次 ${stats.longestPause.toFixed(1)} 秒的较长停顿，前后出声强度相当，已整体保留、没有从停顿中间切开`);
  if (stats.voicedRatio >= 0.85 && span >= 8) reasons.push('整段几乎连续出声、能量稳定，边界仍落在能量回落处，适合做完整的十秒表情');
  else if (stats.voicedRatio >= 0.45 && stats.voicedRatio < 0.85) reasons.push('出声与留白比例自然，停顿分布均匀，没有为凑时长塞入大段静音');
  if (stats.speechDuration < 1.5 && span < 3) reasons.push(`出声只有 ${stats.speechDuration.toFixed(1)} 秒，已完整包含，没有为凑满十秒而拉长静音`);
  if (!reasons.length) reasons.push('出声相对集中，边界尽量落在了能量回落的位置');
  return reasons;
}

/** 时间相近去重：较短窗被较长窗覆盖超过 60% 时，只保留分高的一个 */
function dedupe(windows: ScoredWindow[]): ScoredWindow[] {
  const sorted = [...windows].sort((a, b) => b.score - a.score);
  const kept: ScoredWindow[] = [];
  for (const win of sorted) {
    const duplicate = kept.some((other) => {
      const overlap = Math.min(win.endFrame, other.endFrame) - Math.max(win.startFrame, other.startFrame);
      const shorter = Math.min(win.endFrame - win.startFrame, other.endFrame - other.startFrame);
      return shorter > 0 && overlap / shorter >= 0.6;
    });
    if (!duplicate) kept.push(win);
  }
  return kept;
}

/**
 * “只截最响十秒”的朴素做法：固定十秒滑窗取总能量最大。
 * 保留导出，用于和推荐结果对照（见候选推荐报告）。
 */
export function loudestWindow(profile: AudioProfile): CropRange {
  const { levels, hop, duration } = profile;
  const length = Math.min(MAX_CLIP_SECONDS, duration);
  const width = Math.round(length / hop);
  if (levels.length <= width) return { start: 0, end: duration };
  let energy = 0;
  for (let i = 0; i < width; i += 1) energy += (levels[i] ?? 0) ** 2;
  let bestStart = 0;
  let bestEnergy = energy;
  for (let s = 1; s + width <= levels.length; s += 1) {
    energy += (levels[s + width - 1] ?? 0) ** 2 - (levels[s - 1] ?? 0) ** 2;
    if (energy > bestEnergy) { bestEnergy = energy; bestStart = s; }
  }
  return { start: bestStart * hop, end: Math.min(duration, (bestStart + width) * hop) };
}

export function recommendCandidates(profile: AudioProfile): CandidateRecommendation {
  const { levels, hop, duration } = profile;
  const frameCount = levels.length;
  const { gate, ceiling, active } = resolveGate(levels);
  if (!active || frameCount === 0) {
    return { kind: 'silence', candidates: [], gate, message: '整段几乎只有静音或底噪，没有检测到稳定出声的片段，请手动拖选你要保留的位置。' };
  }
  const allRuns = extractRuns(levels, gate, hop);
  const speechRuns = allRuns.filter((run) => run.speech);
  const speechTotal = speechRuns.reduce((sum, run) => sum + spanSeconds(run.startFrame, run.endFrame, hop), 0);
  if (speechTotal < MIN_SPEECH_SECONDS) {
    return { kind: 'noise', candidates: [], gate, message: '只检测到一两处极短的声响（可能是磕碰或喷麦），没有可推荐的完整片段，请手动选段或重新录制。' };
  }

  // 不足十秒：原音频已经在十秒限制内，整段保留即为最佳候选，
  // 不做任何裁剪/拼接（推荐也不会修改原声音）
  if (duration <= MAX_CLIP_SECONDS + 0.05) {
    const whole = scoreWindow({ startFrame: 0, endFrame: frameCount }, levels, allRuns, gate, ceiling, hop, frameCount);
    const candidate: SegmentCandidate = {
      start: 0,
      end: duration,
      score: whole.score,
      reasons: reasonsFor(whole, duration, duration),
      stats: whole.stats,
    };
    return { kind: 'speech', candidates: [candidate], gate, message: '' };
  }

  const raw: WindowFrames[] = [];
  for (const run of speechRuns) raw.push(...splitLongRun(run, levels, hop));
  raw.push(...buildSeedWindows(speechRuns, hop));

  const scored = Array.from(
    raw
      .map((win) => ((win.endFrame - win.startFrame) * hop > MAX_CLIP_SECONDS + 0.05 ? null : alignEdges(win, allRuns, frameCount, hop)))
      .filter((win): win is WindowFrames => win !== null)
      // 去完全相同的窗
      .reduce((map, win) => map.set(`${win.startFrame}:${win.endFrame}`, win), new Map<string, WindowFrames>())
      .values(),
  ).map((win) => scoreWindow(win, levels, allRuns, gate, ceiling, hop, frameCount));

  const picked = dedupe(scored).slice(0, 3).map((win) => {
    const start = win.startFrame * hop;
    const end = Math.min(duration, win.endFrame * hop);
    return { start, end, score: win.score, reasons: reasonsFor(win, duration, end - start), stats: win.stats };
  });

  return { kind: 'speech', candidates: picked, gate, message: '' };
}
