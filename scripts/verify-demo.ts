/* 端到端核对脚本（非测试）：合成对照声音 → 推荐 → 模拟裁剪，打印时间与内容 */
import { buildDemoVoice, encodeWavPcmBytes, DEMO_VOICES } from '../src/core/demo-audio.ts';
import { recommendCandidates, loudestWindow } from '../src/core/candidate-recommender.ts';
import { WebAudioProfilerAdapter } from '../src/adapters/web-audio-profiler.adapter.ts';
import { encodeWavBytes, type DecodedAudio } from '../src/adapters/web-audio-cropper.adapter.ts';

for (const meta of DEMO_VOICES) {
  const voice = buildDemoVoice(meta.id);
  const decoded: DecodedAudio = { sampleRate: voice.sampleRate, duration: voice.duration, channels: voice.channels };
  const blob = new Blob([encodeWavPcmBytes(voice.channels, voice.sampleRate)]);
  const profiler = new WebAudioProfilerAdapter({ decode: async () => decoded });
  const measured = await profiler.profile(blob);
  const rec = recommendCandidates(measured);
  const loud = loudestWindow(measured);
  console.log(`\n=== ${meta.label}（${voice.duration}s） ${meta.hint}`);
  if (!rec.candidates.length) {
    console.log(`  推荐: 无 → ${rec.message}`);
  }
  rec.candidates.forEach((c, i) => {
    const bytes = encodeWavBytes(decoded, { start: c.start, end: c.end });
    const sampleCount = ((new DataView(bytes.buffer)).getUint32(40, true)) / 2;
    const expected = Math.round((c.end - c.start) * voice.sampleRate);
    console.log(
      `  候选${i + 1}: ${c.start.toFixed(2)}–${c.end.toFixed(2)}s (${(c.end - c.start).toFixed(2)}s) 完整度${(c.score * 100).toFixed(0)} | WAV采样=${sampleCount} 应=${expected} ${sampleCount === expected ? '✓' : '✗偏差'}`,
    );
    for (const reason of c.reasons) console.log(`      · ${reason}`);
  });
  console.log(`  对照[只截最响十秒]: ${loud.start.toFixed(2)}–${loud.end.toFixed(2)}s`);
}
