<script setup lang="ts">
import type { CandidateSegment } from '../../core/models';

const props = defineProps<{
  duration: number;
  start: number;
  end: number;
  candidates: CandidateSegment[];
  selectedCandidateId: string;
  previewUrl: string;
  previewStart?: number;
  previewEnd?: number;
}>();
const emit = defineEmits<{
  updateStart: [n: number];
  updateEnd: [n: number];
  selectCandidate: [candidate: CandidateSegment];
  previewCandidate: [candidate: CandidateSegment];
  clearCandidate: [];
  analyze: [];
}>();

function updateStart(value: number) {
  emit('updateStart', value);
  emit('clearCandidate');
}
function updateEnd(value: number) {
  emit('updateEnd', value);
  emit('clearCandidate');
}
</script>

<template>
  <section class="stage-card crop-stage">
    <span class="kicker">02 / TRIM THE MOMENT</span>
    <h2>试听候选，再留下十秒</h2>

    <div v-if="candidates.length" class="candidate-list" data-testid="candidate-list">
      <article
        v-for="candidate in candidates"
        :key="candidate.id"
        class="candidate-card"
        :class="{ active: candidate.id === selectedCandidateId }"
        :data-testid="candidate.id"
      >
        <header>
          <b>候选 {{ candidate.rank }}</b>
          <span>{{ candidate.start.toFixed(2) }}s – {{ candidate.end.toFixed(2) }}s · {{ (candidate.end - candidate.start).toFixed(2) }}s · 匹配 {{ Math.round(candidate.score * 100) }}%</span>
        </header>
        <ul>
          <li v-for="reason in candidate.reasons" :key="reason">{{ reason }}</li>
        </ul>
        <footer>
          <button type="button" data-action="preview" @click="emit('previewCandidate', candidate)">试听</button>
          <button type="button" class="primary-choice" data-action="use" @click="emit('selectCandidate', candidate)">用这段</button>
        </footer>
      </article>
    </div>
    <div v-else class="manual-crop" data-testid="manual-crop">
      没有找到足够稳定的自动候选，请先手动选择起止点。
    </div>

    <audio
      v-if="previewUrl"
      class="candidate-player"
      data-testid="candidate-preview"
      :src="previewUrl"
      controls
      preload="metadata"
    ></audio>
    <p v-if="previewStart !== undefined && previewEnd !== undefined" class="preview-times">
      试听范围：{{ previewStart.toFixed(2) }}s – {{ previewEnd.toFixed(2) }}s；进入分析时会按当前滑块范围再次裁剪。
    </p>

    <div class="timeline">
      <div
        v-for="candidate in candidates"
        :key="`${candidate.id}-mark`"
        class="candidate-mark"
        :class="{ active: candidate.id === selectedCandidateId }"
        :style="{ left: `${(candidate.start / duration) * 100 || 0}%`, width: `${((candidate.end - candidate.start) / duration) * 100 || 0}%` }"
      ></div>
      <div class="timeline-fill" :style="{ left: `${(start / duration) * 100 || 0}%`, right: `${100 - ((end / duration) * 100 || 0)}%` }"></div>
    </div>

    <div class="range-pair">
      <label>起点 {{ start.toFixed(2) }}s
        <input
          type="range"
          min="0"
          :max="Math.max(0, duration - .01)"
          step=".01"
          :value="start"
          @input="updateStart(Number(($event.target as HTMLInputElement).value))"
        >
      </label>
      <label>终点 {{ end.toFixed(2) }}s
        <input
          type="range"
          :min="Math.min(duration, start + .01)"
          :max="duration"
          step=".01"
          :value="end"
          @input="updateEnd(Number(($event.target as HTMLInputElement).value))"
        >
      </label>
    </div>
    <button data-testid="analyze" class="acid-button" type="button" @click="emit('analyze')">分析这段声音 →</button>
  </section>
</template>
