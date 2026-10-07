<script setup lang="ts">
import type { AudioProfile, CandidateRecommendation, SegmentCandidate } from '../../core/candidate-recommender';
import { computed } from 'vue';

const props = defineProps<{
  duration: number;
  start: number;
  end: number;
  profile?: AudioProfile;
  recommendation?: CandidateRecommendation;
  recommending: boolean;
  auditionIndex: number;
}>();
const emit = defineEmits<{
  updateStart: [n: number];
  updateEnd: [n: number];
  analyze: [];
  audition: [candidate: SegmentCandidate, index: number];
  stopAudition: [];
  choose: [candidate: SegmentCandidate];
  previewRange: [];
}>();

const STEP = 0.1;
const pct = (time: number) => `${(time / Math.max(props.duration, 0.001)) * 100}%`;
const bars = computed(() => (props.profile?.peaks.length ? props.profile.peaks : Array.from({ length: 96 }, () => 0.06)));
const inSelection = (index: number) => {
  const t = (index / bars.value.length) * props.duration;
  return t >= props.start && t <= props.end;
};
const nudgeStart = (delta: number) => emit('updateStart', Math.min(Math.max(0, props.start + delta), props.end - 0.1));
const nudgeEnd = (delta: number) => emit('updateEnd', Math.max(Math.min(props.duration, props.end + delta), props.start + 0.1));
const fmt = (value: number) => value.toFixed(1);
</script>

<template>
  <section class="stage-card crop-card">
    <span class="kicker">02 / TRIM THE MOMENT</span>
    <h2>留下最有表情的十秒</h2>

    <div v-if="recommending" class="candidate-hint" data-testid="recommending">正在分析能量变化与停顿分布…</div>

    <div v-if="recommendation && recommendation.candidates.length" class="candidate-list" data-testid="candidate-list">
      <p class="candidate-title">候选片段（依据能量回落与停顿边界自动选取，最多 3 段，均可试听微调）</p>
      <article
        v-for="(candidate, index) in recommendation.candidates"
        :key="`${candidate.start}-${candidate.end}`"
        class="candidate-card"
        :data-testid="`candidate-${index}`"
        :data-active="start === candidate.start && end === candidate.end"
      >
        <header>
          <b>候选 {{ index + 1 }}</b>
          <span class="candidate-time">{{ fmt(candidate.start) }}s – {{ fmt(candidate.end) }}s · {{ fmt(candidate.end - candidate.start) }}s</span>
          <span class="candidate-score">完整度 {{ Math.round(candidate.score * 100) }}</span>
        </header>
        <ul class="candidate-reasons">
          <li v-for="reason in candidate.reasons" :key="reason">{{ reason }}</li>
        </ul>
        <footer>
          <button
            type="button"
            class="candidate-audition"
            :data-testid="`audition-${index}`"
            @click="auditionIndex === index ? emit('stopAudition') : emit('audition', candidate, index)"
          >{{ auditionIndex === index ? '■ 停止试听' : '▶ 试听' }}</button>
          <button type="button" class="candidate-choose" :data-testid="`choose-${index}`" @click="emit('choose', candidate)">选用并微调</button>
        </footer>
      </article>
    </div>

    <div v-else-if="!recommending" class="candidate-empty" data-testid="candidate-empty">
      <b>没有找到合适的候选</b>
      <p>{{ recommendation?.message || '可以直接在下方手动拖选起止点。' }}</p>
    </div>

    <div class="timeline crop-timeline">
      <div class="timeline-bars">
        <i v-for="(peak, index) in bars" :key="index" :style="{ height: `${18 + Math.min(1, peak) * 74}%`, opacity: inSelection(index) ? 1 : 0.28 }"></i>
      </div>
      <div class="timeline-fill" :style="{ left: pct(start), right: `${100 - (end / Math.max(duration, 0.001)) * 100}%` }"></div>
    </div>

    <div class="range-pair">
      <label>起点 {{ start.toFixed(1) }}s
        <input type="range" min="0" :max="Math.max(0, duration - .1)" step=".1" :value="start" @input="emit('updateStart', Number(($event.target as HTMLInputElement).value))">
        <span class="nudge-row"><button type="button" @click="nudgeStart(-STEP)">-0.1s</button><button type="button" @click="nudgeStart(STEP)">+0.1s</button></span>
      </label>
      <label>终点 {{ end.toFixed(1) }}s
        <input type="range" :min="Math.min(duration, start + .1)" :max="duration" step=".1" :value="end" @input="emit('updateEnd', Number(($event.target as HTMLInputElement).value))">
        <span class="nudge-row"><button type="button" @click="nudgeEnd(-STEP)">-0.1s</button><button type="button" @click="nudgeEnd(STEP)">+0.1s</button></span>
      </label>
    </div>

    <div class="crop-actions">
      <button type="button" class="ghost-button" data-testid="preview-range" @click="auditionIndex === -2 ? emit('stopAudition') : emit('previewRange')">
        {{ auditionIndex === -2 ? '■ 停止' : '▶ 试听当前选段' }}
      </button>
      <button data-testid="analyze" class="acid-button" type="button" @click="emit('analyze')">分析这段声音 →</button>
    </div>
    <p class="crop-foot">候选只参考声音能量与停顿，不含任何语音识别；推荐不会修改原声音，进入分析后才生成裁剪文件。</p>
  </section>
</template>
