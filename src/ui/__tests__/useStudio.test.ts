import { describe, expect, it, vi } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { VoiceMeme } from '../../core/models';
import { recommendCandidates, type AudioProfile } from '../../core/candidate-recommender';

function dependencies(overrides: Partial<StudioDependencies> = {}): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async () => ({ duration: 2, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }) },
    cropper: { inspect: async () => ({duration:2,needsCrop:false}), crop: async (blob, range) => ({blob,duration:range.end-range.start}) },
    profiler: { profile: async () => ({ duration:2, sampleRate:16000, hop:.025, levels:new Float32Array(80).fill(.2), peaks:[.2] }) },
    preview: { play: async () => {}, stop: () => {} },
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => 'shared' },
    ...overrides,
  };
}

describe('useStudio', () => {
  it('turns microphone denial into a recoverable error', async () => {
    const studio = useStudio(dependencies({ recorder: { isRecording:false, start:async()=>{throw new DOMException('denied','NotAllowedError')}, stop:async()=>new Blob() } }));
    await studio.startRecording();
    expect(studio.error.value).toContain('麦克风权限');
    expect(studio.stage.value).toBe('record');
  });
  it('moves recording through crop and emotion with manual override', async () => {
    const studio = useStudio(dependencies()); await studio.startRecording(); await studio.stopRecording();
    expect(studio.stage.value).toBe('crop'); await studio.analyze(); expect(studio.emotion.value?.label).toBe('元气满满');
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.stage.value).toBe('emotion');
  });
  it('推荐候选：长音频录音后生成候选，试听与最终分析使用同一个 crop 区间', async () => {
    const duration = 14;
    const frames = Math.round(duration / 0.025);
    const levels = new Float32Array(frames).fill(0.001);
    for (let f = Math.round(1 / 0.025); f < Math.round(3 / 0.025); f += 1) levels[f] = 0.3;
    for (let f = Math.round(9.5 / 0.025); f < Math.round(11.5 / 0.025); f += 1) levels[f] = 0.3;
    const measured: AudioProfile = { duration, sampleRate: 16000, hop: 0.025, levels, peaks: [] };
    const expected = recommendCandidates(measured);
    expect(expected.candidates.length).toBeGreaterThan(0);
    const crop = vi.fn(async (blob: Blob, range: { start: number; end: number }) => ({ blob, duration: range.end - range.start }));
    const play = vi.fn(async () => {});
    const studio = useStudio(dependencies({
      cropper: { inspect: async () => ({ duration, needsCrop: true }), crop },
      profiler: { profile: async () => measured },
      preview: { play, stop: () => {} },
    }));
    await studio.startRecording();
    await studio.stopRecording();
    expect(studio.stage.value).toBe('crop');
    expect(studio.recommendation.value?.candidates.length).toBe(expected.candidates.length);

    const first = studio.recommendation.value!.candidates[0]!;
    await studio.auditionCandidate(first, 0);
    expect(crop).toHaveBeenCalledWith(expect.any(Blob), { start: first.start, end: first.end });
    expect(play).toHaveBeenCalledTimes(1);

    studio.chooseCandidate(first);
    expect(studio.draft.cropStart).toBe(first.start);
    expect(studio.draft.cropEnd).toBe(first.end);
    // 微调后再分析，裁剪区间用的是微调后的值
    studio.draft.cropStart += 0.1;
    await studio.analyze();
    expect(crop).toHaveBeenLastCalledWith(expect.any(Blob), { start: first.start + 0.1, end: first.end });
    expect(studio.stage.value).toBe('emotion');
  });

  it('profiler 失败不阻塞：仍进入裁剪页并允许手动选段', async () => {
    const studio = useStudio(dependencies({
      cropper: { inspect: async () => ({ duration: 12, needsCrop: true }), crop: async (blob, range) => ({ blob, duration: range.end - range.start }) },
      profiler: { profile: async () => { throw new DOMException('decode', 'EncodingError'); } },
    }));
    await studio.startRecording();
    await studio.stopRecording();
    expect(studio.stage.value).toBe('crop');
    expect(studio.recommendation.value).toBeUndefined();
    expect(studio.notice.value).toContain('手动');
    studio.draft.cropStart = 2; studio.draft.cropEnd = 8;
    await studio.analyze();
    expect(studio.stage.value).toBe('emotion');
  });

  it('keeps the draft when saving fails and can edit an existing work', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
  });
});
