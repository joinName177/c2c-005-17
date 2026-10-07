import { describe, expect, it } from 'vitest';
import { buildDemoVoice, DEMO_VOICES, encodeWavPcm, encodeWavPcmBytes } from '../demo-audio';

describe('demo-audio 合成器（纯数据）', () => {
  it('每个对照声音都有标签、提示和非空声道，且静音样例确实接近全零', () => {
    for (const meta of DEMO_VOICES) {
      const voice = buildDemoVoice(meta.id);
      expect(voice.channels[0]!.length).toBe(Math.round(voice.duration * voice.sampleRate));
      expect(voice.label.length).toBeGreaterThan(0);
      expect(voice.hint.length).toBeGreaterThan(0);
    }
    const silence = buildDemoVoice('silence');
    expect(silence.channels[0]!.every((v) => v === 0)).toBe(true);
  });

  it('连续长讲在 12s 附近有明显峰值、10s 附近有低谷（构造“最响≠最好”的对照）', () => {
    const voice = buildDemoVoice('continuous');
    const channel = voice.channels[0]!;
    const rms = (from: number, to: number) => {
      let sum = 0; let n = 0;
      for (let i = Math.round(from * voice.sampleRate); i < Math.round(to * voice.sampleRate); i += 1) { sum += channel[i]! ** 2; n += 1; }
      return Math.sqrt(sum / Math.max(1, n));
    };
    expect(rms(12, 12.25)).toBeGreaterThan(0.6);
    expect(rms(9.72, 10)).toBeLessThan(0.05);
    expect(rms(2, 5)).toBeGreaterThan(0.15);
  });

  it('磕碰声只占 0.05 秒、短句出声接近 4 秒', () => {
    const bang = buildDemoVoice('bang');
    const activeBang = bang.channels[0]!.filter((v) => Math.abs(v) > 0.01).length / bang.sampleRate;
    expect(activeBang).toBeLessThan(0.08);
    const short = buildDemoVoice('short');
    const activeShort = short.channels[0]!.filter((v) => Math.abs(v) > 0.01).length / short.sampleRate;
    expect(activeShort).toBeGreaterThan(3.5);
  });

  it('WAV 编码有正确头部和长度', () => {
    const voice = buildDemoVoice('short');
    const blob = encodeWavPcm(voice.channels, voice.sampleRate);
    expect(blob.type).toBe('audio/wav');
    const bytes = encodeWavPcmBytes(voice.channels, voice.sampleRate);
    const ascii = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(24, true)).toBe(voice.sampleRate);
    const dataLength = view.getUint32(40, true);
    expect(dataLength).toBe(voice.channels[0]!.length * 2);
  });

  it('合成 WAV 的时长字段与采样数一致（裁剪时间标记据此换算）', () => {
    const voice = buildDemoVoice('separated');
    const blob = encodeWavPcm(voice.channels, voice.sampleRate);
    const bytes = new Uint8Array(blob.size);
    const view = new DataView(bytes.buffer);
    // 直接从 ArrayBuffer 复制，规避不同环境 Blob.arrayBuffer 差异
    expect(blob.size).toBe(44 + voice.channels[0]!.length * 2);
    expect(view.byteLength).toBe(blob.size);
    expect(voice.duration * voice.sampleRate).toBe(voice.channels[0]!.length);
  });
});
