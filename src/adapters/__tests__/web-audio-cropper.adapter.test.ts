import { describe, expect, it } from 'vitest';
import { WebAudioCropperAdapter, type DecodedAudio } from '../web-audio-cropper.adapter';
import { WebAudioAnalyzerAdapter } from '../web-audio-analyzer.adapter';

const decoded = (duration = 12): DecodedAudio => ({ sampleRate: 10, duration, channels: [Float32Array.from({ length: duration * 10 }, (_, index) => index % 5 ? .4 : 0)] });

describe('WebAudioCropperAdapter', () => {
  it('marks imports over ten seconds as requiring crop', async () => {
    const adapter = new WebAudioCropperAdapter({ decode: async () => decoded(12) });
    const result = await adapter.inspect(new Blob());
    expect({ duration: result.duration, needsCrop: result.needsCrop }).toEqual({ duration: 12, needsCrop: true });
    expect(Array.isArray(result.candidates)).toBe(true);
  });
  it('caps encoded output range at ten seconds', async () => {
    const adapter = new WebAudioCropperAdapter({ decode: async () => decoded(12) });
    const result = await adapter.crop(new Blob(), { start: 1, end: 11 });
    expect(result.duration).toBe(10);
    expect(result.blob.type).toBe('audio/wav');
  });
  it('encodes the exact selected sample range', async () => {
    const audio: DecodedAudio = { sampleRate: 100, duration: 120, channels: [Float32Array.from({ length: 1200 }, (_, index) => index >= 20 && index < 240 ? 0.4 : 0)] };
    const adapter = new WebAudioCropperAdapter({ decode: async () => audio });
    const selected = { start: 0.2, end: 2.4 };
    const result = await adapter.crop(new Blob(), selected);
    const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(result.blob);
    });
    const view = new DataView(arrayBuffer);
    const dataOffset = 44;
    const firstFrames = Array.from({ length: 5 }, (_, index) => view.getInt16(dataOffset + index * 2, true));
    const startSample = Math.round(selected.start * audio.sampleRate);
    expect(firstFrames).toEqual(Array.from({ length: 5 }, (_, index) => Math.floor(audio.channels[0]![startSample + index]! * 32767)));
    expect(result.duration).toBeCloseTo(selected.end - selected.start, 5);
  });

});

describe('WebAudioAnalyzerAdapter', () => {
  it('extracts finite normalized features and duration', async () => {
    const result = await new WebAudioAnalyzerAdapter({ decode: async () => decoded(2) }).analyze(new Blob());
    expect(result.duration).toBe(2);
    expect(Object.values(result.features).every(Number.isFinite)).toBe(true);
  });
});
