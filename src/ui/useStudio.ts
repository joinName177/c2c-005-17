import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import type { AudioFeatures, CandidateSegment, CoverConfig, EmotionLabel, EmotionResult, StudioStage, VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }
export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);
  const candidates = ref<CandidateSegment[]>([]); const selectedCandidateId = ref(''); const previewUrl = ref(''); const previewRange = ref<{ start: number; end: number }>();
  function resetCropRecommendations() { candidates.value = []; selectedCandidateId.value = ''; if (previewUrl.value) URL.revokeObjectURL(previewUrl.value); previewUrl.value = ''; previewRange.value = undefined; }
  function applyInspection(blob: Blob, info: { duration: number; needsCrop: boolean; candidates?: CandidateSegment[] }) {
    resetCropRecommendations(); draft.audio = blob; draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration);
    candidates.value = info.candidates ?? [];
    if (candidates.value.length > 0) selectCandidate(candidates.value[0]!);
    notice.value = candidates.value.length
      ? `已推荐 ${candidates.value.length} 个候选片段，可试听后微调`
      : info.needsCrop ? '没有找到足够稳定的声音候选，请手动选择片段' : '音频较短，可直接试听并分析';
  }


  async function startRecording() { error.value = ''; notice.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() { try { const blob = await deps.recorder.stop(); const info = await deps.cropper.inspect(blob); applyInspection(blob, info); stage.value = 'crop'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { try { const info = await deps.cropper.inspect(blob); applyInspection(blob, info); stage.value = 'crop'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法解析这段音频，请换用浏览器支持的声音文件。'; } }
  function selectCandidate(candidate: CandidateSegment) { selectedCandidateId.value = candidate.id; draft.cropStart = candidate.start; draft.cropEnd = candidate.end; previewRange.value = { start: candidate.start, end: candidate.end }; }
  function clearSelectedCandidate() { selectedCandidateId.value = ''; }
  async function previewCandidate(candidate: CandidateSegment) {
    if (!draft.audio) return;
    selectCandidate(candidate);
    try {
      if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
      previewUrl.value = '';
      const result = await deps.cropper.crop(draft.audio, { start: candidate.start, end: candidate.end });
      if (selectedCandidateId.value !== candidate.id) return;
      previewUrl.value = URL.createObjectURL(result.blob); previewRange.value = { start: candidate.start, end: candidate.end };
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '候选试听生成失败'; }
  }
  async function analyze() { if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; } try { const range = { start: draft.cropStart, end: draft.cropEnd }; const cropped = await deps.cropper.crop(draft.audio, range); draft.audio = cropped.blob; draft.duration = cropped.duration; resetCropRecommendations(); const result = await deps.analyzer.analyze(cropped.blob); features.value = result.features; emotion.value = classifyEmotion(result.features); cover.value = coverPresetFor(emotion.value.label); stage.value = 'emotion'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '声音分析失败，请调整裁剪范围后重试'; } }
  function selectEmotion(label: EmotionLabel) { const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) { if (!draft.audio || !emotion.value || !features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; } try { const coverBlob = await deps.renderer.render(cover.value, target); const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: draft.audio, duration: draft.duration, cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() }; await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地'; } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; } }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) { resetCropRecommendations(); Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration }); features.value = meme.features; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig }; stage.value = 'cover'; }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() { resetCropRecommendations(); draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; draft.duration = 0; draft.cropStart = 0; draft.cropEnd = 0; emotion.value = undefined; features.value = undefined; stage.value = 'record'; error.value = ''; }
  return { stage,error,notice,level,draft,candidates,selectedCandidateId,previewUrl,previewRange,emotion,features,cover,collection,startRecording,stopRecording,importAudio,selectCandidate,clearSelectedCandidate,previewCandidate,analyze,selectEmotion,goCover,save,loadCollection,editMeme,deleteMeme,shareMeme,newRecording };
}
