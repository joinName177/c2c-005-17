/**
 * 对照声音合成（纯函数，便于测试）。
 * 用能量包络 × 载波生成 PCM，刻意构造“最响十秒≠最佳十秒”的情形，
 * 用来展示候选推荐和朴素响度截取的差异。这些声音不含任何语义内容。
 */

export interface DemoVoice {
  id: string;
  label: string;
  /** 这组对照想说明什么（只描述声学结构） */
  hint: string;
  sampleRate: number;
  duration: number;
  channels: Float32Array[];
}

export const DEMO_SAMPLE_RATE = 16000;

interface Tone { start: number; end: number; gain: number; frequency: number }

function tone(samples: Float32Array, sampleRate: number, { start, end, gain, frequency }: Tone): void {
  const from = Math.max(0, Math.round(start * sampleRate));
  const to = Math.min(samples.length, Math.round(end * sampleRate));
  // 起止 20ms 淡入淡出，避免包络跳变制造假的爆音
  const fade = Math.round(0.02 * sampleRate);
  for (let i = from; i < to; i += 1) {
    const t = (i - from) / sampleRate;
    const envelopeIn = Math.min(1, (i - from) / fade);
    const envelopeOut = Math.min(1, (to - i) / fade);
    samples[i] = gain * envelopeIn * envelopeOut * Math.sin(2 * Math.PI * frequency * t);
  }
}

function build(duration: number, tones: Tone[], sampleRate = DEMO_SAMPLE_RATE): Float32Array[] {
  const samples = new Float32Array(Math.round(duration * sampleRate));
  for (const spec of tones) tone(samples, sampleRate, spec);
  return [samples];
}

/** 连续讲话：0~24s 持续出声，10s 附近留一个换气低谷，12s 放一声短促巨响 */
function continuousLongSpeech(): Float32Array[] {
  const duration = 24;
  const sampleRate = DEMO_SAMPLE_RATE;
  const samples = new Float32Array(Math.round(duration * sampleRate));
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / sampleRate;
    const inDip = t >= 9.72 && t < 10;
    const inSpike = t >= 12 && t < 12.25;
    const gain = inDip ? 0.02 : inSpike ? 0.95 : 0.26 + 0.03 * Math.sin(2 * Math.PI * 2 * t);
    // 频率缓慢漂移，模拟连续语流而不是死信号
    const frequency = 150 + 25 * Math.sin(2 * Math.PI * 0.4 * t);
    samples[i] = gain * Math.sin(2 * Math.PI * frequency * t);
  }
  return [samples];
}

export const DEMO_VOICES: Array<Pick<DemoVoice, 'id' | 'label' | 'hint'>> = [
  { id: 'silence', label: '全静音 8s', hint: '只有底噪：不硬推候选，提示手动选段' },
  { id: 'bang', label: '一声磕碰 6s', hint: '0.05 秒短促噪声：判定为噪声而非“一句话”' },
  { id: 'short', label: '短句 6s', hint: '不足十秒：整段保留，不拼静音凑时长' },
  { id: 'paused', label: '一句带长停顿 4.8s', hint: '中间 0.55 秒停顿属于同一句，整体跨过' },
  { id: 'separated', label: '两句长间隔 14s', hint: '两句间隔 6.5 秒：拆成两个候选，绝不硬拼' },
  { id: 'continuous', label: '连续长讲 24s', hint: '12s 有一声巨响：最响十秒≠最佳十秒' },
  { id: 'radio', label: '稀疏出声 20s', hint: '出声短、留白长：优先完整边界而非平均响度' },
];

function channelsFor(id: string): { channels: Float32Array[]; duration: number } {
  switch (id) {
    case 'silence':
      return { channels: build(8, []), duration: 8 };
    case 'bang':
      return { channels: build(6, [{ start: 3, end: 3.05, gain: 0.9, frequency: 200 }]), duration: 6 };
    case 'short':
      return { channels: build(6, [{ start: 0.5, end: 4.5, gain: 0.32, frequency: 160 }]), duration: 6 };
    case 'paused':
      return {
        channels: build(4.8, [
          { start: 0.3, end: 2.1, gain: 0.3, frequency: 160 },
          { start: 2.65, end: 4.5, gain: 0.3, frequency: 165 },
        ]),
        duration: 4.8,
      };
    case 'separated':
      return {
        channels: build(14, [
          { start: 1, end: 3, gain: 0.33, frequency: 155 },
          { start: 9.5, end: 11.5, gain: 0.33, frequency: 170 },
        ]),
        duration: 14,
      };
    case 'continuous':
      return { channels: continuousLongSpeech(), duration: 24 };
    case 'radio':
      return {
        channels: build(20, [
          { start: 2, end: 2.9, gain: 0.3, frequency: 150 },
          { start: 6.2, end: 7, gain: 0.28, frequency: 160 },
          { start: 14.4, end: 15.6, gain: 0.31, frequency: 165 },
          { start: 18.2, end: 18.8, gain: 0.29, frequency: 158 },
        ]),
        duration: 20,
      };
    default:
      return { channels: build(1, []), duration: 1 };
  }
}

/** 16-bit PCM 小端 WAV 编码（与裁剪适配器同规格，浏览器可直接解码试听） */
export function encodeWavPcmBytes(channels: Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const length = Math.min(...channels.map((c) => c.length));
  const buffer = new ArrayBuffer(44 + length * channels.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + length * channels.length * 2, true); write(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels.length * 2, true);
  view.setUint16(32, channels.length * 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, length * channels.length * 2, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1) for (const channel of channels) {
    const value = Math.max(-1, Math.min(1, channel[i] ?? 0));
    view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function encodeWavPcm(channels: Float32Array[], sampleRate: number): Blob {
  return new Blob([encodeWavPcmBytes(channels, sampleRate)], { type: 'audio/wav' });
}

export function buildDemoVoice(id: string): DemoVoice {
  const meta = DEMO_VOICES.find((voice) => voice.id === id);
  const { channels, duration } = channelsFor(id);
  return {
    id,
    label: meta?.label ?? id,
    hint: meta?.hint ?? '',
    sampleRate: DEMO_SAMPLE_RATE,
    duration,
    channels,
  };
}
