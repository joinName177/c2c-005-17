import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import {
  recommendCandidates,
  type AudioProfile,
  type CandidateRecommendation,
  type SegmentCandidate,
} from '../core/candidate-recommender';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, StudioStage, VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { AudioProfilerPort } from '../ports/audio-profiler.port';
import type { AudioPreviewPort } from '../ports/audio-preview.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies {
  recorder: RecorderPort;
  analyzer: AudioAnalyzerPort;
  cropper: AudioCropperPort;
  profiler: AudioProfilerPort;
  preview: AudioPreviewPort;
  renderer: CoverRendererPort;
  repository: MemeRepository;
  share: SharePort;
}
export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);
  const profile = ref<AudioProfile>();
  const recommendation = ref<CandidateRecommendation>();
  const recommending = ref(false);
  const auditionIndex = ref<number>(-1);

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }

  async function inspectDraft(blob: Blob, fromImport = false) {
    const info = await deps.cropper.inspect(blob);
    draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration);
    profile.value = undefined; recommendation.value = undefined; auditionIndex.value = -1;
    stage.value = 'crop';
    notice.value = info.needsCrop ? '已按声音能量和停顿生成候选片段，可试听后微调' : '录音完成，不足十秒将整段保留';
    try {
      recommending.value = true;
      const measured = await deps.profiler.profile(blob);
      profile.value = measured;
      recommendation.value = recommendCandidates(measured);
      if (!recommendation.value.candidates.length) notice.value = recommendation.value.message;
    } catch {
      // 能量分析失败不阻塞裁剪：用户仍可手动拖选
      notice.value = fromImport ? '该音频无法解码能量曲线，请手动选择片段' : '暂时无法分析声音能量，请手动选择片段';
    } finally {
      recommending.value = false;
    }
  }

  async function stopRecording() { try { const blob = await deps.recorder.stop(); draft.audio = blob; await inspectDraft(blob); } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { draft.audio = blob; await inspectDraft(blob, true); }

  /** 试听/选用/最终分析都走同一个 cropper.crop，时间标记一致，且不改动原声音 Blob */
  async function auditionCandidate(candidate: SegmentCandidate, index: number) {
    if (!draft.audio) return;
    try {
      auditionIndex.value = index;
      const cropped = await deps.cropper.crop(draft.audio, { start: candidate.start, end: candidate.end });
      await deps.preview.play(cropped.blob);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '试听失败';
    } finally {
      auditionIndex.value = -1;
    }
  }
  function stopAudition() { deps.preview.stop(); auditionIndex.value = -1; }
  function chooseCandidate(candidate: SegmentCandidate) {
    draft.cropStart = candidate.start;
    draft.cropEnd = candidate.end;
    notice.value = '已套用候选，仍可拖动滑块微调起止点';
  }
  async function previewRange() {
    if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; }
    try {
      auditionIndex.value = -2;
      const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd });
      await deps.preview.play(cropped.blob);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '试听失败';
    } finally {
      auditionIndex.value = -1;
    }
  }

  async function analyze() {
    if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; }
    deps.preview.stop();
    const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd });
    draft.audio = cropped.blob; draft.duration = cropped.duration;
    const result = await deps.analyzer.analyze(cropped.blob); features.value = result.features; emotion.value = classifyEmotion(result.features); cover.value = coverPresetFor(emotion.value.label); stage.value = 'emotion';
  }
  function selectEmotion(label: EmotionLabel) { const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) { if (!draft.audio || !emotion.value || !features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; } try { const coverBlob = await deps.renderer.render(cover.value, target); const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: draft.audio, duration: draft.duration, cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() }; await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地'; } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; } }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) { Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration }); features.value = meme.features; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig }; stage.value = 'cover'; }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() { draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; emotion.value = undefined; features.value = undefined; profile.value = undefined; recommendation.value = undefined; stage.value = 'record'; error.value = ''; }
  return { stage,error,notice,level,draft,emotion,features,cover,collection,profile,recommendation,recommending,auditionIndex,startRecording,stopRecording,importAudio,inspectDraft,auditionCandidate,stopAudition,chooseCandidate,previewRange,analyze,selectEmotion,goCover,save,loadCollection,editMeme,deleteMeme,shareMeme,newRecording };
}
