<script setup lang="ts">
import { ref } from 'vue';
import { buildDemoVoice, DEMO_VOICES, encodeWavPcm } from '../../core/demo-audio';
import { loudestWindow, recommendCandidates, type AudioProfile } from '../../core/candidate-recommender';
import { WebAudioProfilerAdapter } from '../../adapters/web-audio-profiler.adapter';
import type { DecodedAudio } from '../../adapters/web-audio-cropper.adapter';

const emit = defineEmits<{ load: [blob: Blob] }>();
const expanded = ref<string>();
const comparisons = ref<Record<string, { profile: AudioProfile; loudest: { start: number; end: number }; recommendationCount: number; message: string }>>({});

async function toggle(id: string) {
  if (expanded.value === id) { expanded.value = undefined; return; }
  expanded.value = id;
  if (comparisons.value[id]) return;
  const voice = buildDemoVoice(id);
  const decoded: DecodedAudio = { sampleRate: voice.sampleRate, duration: voice.duration, channels: voice.channels };
  const profiler = new WebAudioProfilerAdapter({ decode: async () => decoded });
  const blob = encodeWavPcm(voice.channels, voice.sampleRate);
  const measured = await profiler.profile(blob);
  const recommendation = recommendCandidates(measured);
  const loudest = loudestWindow(measured);
  comparisons.value = {
    ...comparisons.value,
    [id]: { profile: measured, loudest, recommendationCount: recommendation.candidates.length, message: recommendation.message },
  };
}

function loadDemo(id: string) {
  const voice = buildDemoVoice(id);
  emit('load', encodeWavPcm(voice.channels, voice.sampleRate));
}

const fmt = (n: number) => n.toFixed(1);
</script>

<template>
  <section class="demo-panel" data-testid="demo-panel">
    <span class="kicker">REFERENCE SOUNDS / 对照声音</span>
    <h3>没有长音频？用这 7 组对照声音看推荐差异</h3>
    <p class="demo-intro">每组都是合成的能量包络，不含真实语音；点开可看到“推荐候选”与“只截最响十秒”的边界差异，再载入裁剪页亲自试听。</p>
    <div class="demo-grid">
      <article v-for="voice in DEMO_VOICES" :key="voice.id" class="demo-item" :data-testid="`demo-${voice.id}`">
        <header>
          <b>{{ voice.label }}</b>
          <button type="button" class="demo-toggle" @click="toggle(voice.id)">{{ expanded === voice.id ? '收起' : '对比' }}</button>
        </header>
        <p>{{ voice.hint }}</p>
        <div v-if="expanded === voice.id" class="demo-detail" :data-testid="`demo-detail-${voice.id}`">
          <template v-if="comparisons[voice.id]">
            <div class="demo-bars">
              <i
                v-for="(peak, index) in comparisons[voice.id]!.profile.peaks"
                :key="index"
                :style="{ height: `${12 + Math.min(1, peak) * 80}%` }"
              ></i>
            </div>
            <dl>
              <dt>只截最响十秒</dt>
              <dd>{{ fmt(comparisons[voice.id]!.loudest.start) }}s – {{ fmt(comparisons[voice.id]!.loudest.end) }}s（追逐峰值，可能切断表达）</dd>
              <template v-if="comparisons[voice.id]!.recommendationCount">
                <dt>推荐候选</dt>
                <dd>{{ comparisons[voice.id]!.recommendationCount }} 段，按完整度排序、相近去重，全部 ≤10s</dd>
              </template>
              <template v-else>
                <dt>推荐候选</dt>
                <dd>{{ comparisons[voice.id]!.message }}</dd>
              </template>
            </dl>
          </template>
          <span v-else class="demo-loading">分析中…</span>
          <button type="button" class="acid-button demo-load" :data-testid="`demo-load-${voice.id}`" @click="loadDemo(voice.id)">载入到裁剪页 →</button>
        </div>
      </article>
    </div>
  </section>
</template>
