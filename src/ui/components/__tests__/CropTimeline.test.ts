import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import CropTimeline from '../CropTimeline.vue';
import type { CandidateRecommendation } from '../../../core/candidate-recommender';

const candidate = (start: number, end: number, score: number, reasons: string[]) => ({
  start, end, score, reasons,
  stats: { speechDuration: 2, longestPause: 0.5, voicedRatio: 0.7, edgeQuiet: 0.9, noiseFraction: 0 },
});

const recommendation: CandidateRecommendation = {
  kind: 'speech',
  gate: 0.04,
  message: '',
  candidates: [
    candidate(1, 4, 0.9, ['起止位置都在能量明显回落处或音频端点，出声段的开头和结尾没有被切断']),
    candidate(9.5, 11.5, 0.8, ['出声与留白比例自然，停顿分布均匀，没有为凑时长塞入大段静音']),
  ],
};

function mountCrop(overrides: Record<string, unknown> = {}) {
  return mount(CropTimeline, {
    props: {
      duration: 14,
      start: 0,
      end: 10,
      recommendation,
      recommending: false,
      auditionIndex: -1,
      ...overrides,
    },
  });
}

describe('CropTimeline 候选推荐', () => {
  it('渲染最多候选卡片，展示时间、时长、完整度与声学理由，不含语义化文案', () => {
    const wrapper = mountCrop();
    expect(wrapper.findAll('[data-testid^="candidate-"]').filter((n) => /candidate-\d+$/.test(n.attributes('data-testid') ?? ''))).toHaveLength(2);
    expect(wrapper.text()).toContain('1.0s – 4.0s · 3.0s');
    expect(wrapper.text()).toContain('完整度 90');
    expect(wrapper.text()).toContain('能量明显回落处');
    expect(wrapper.text()).not.toContain('识别出“');
  });

  it('点试听发出带候选与序号的事件，点停止发出 stopAudition', async () => {
    const wrapper = mountCrop();
    await wrapper.get('[data-testid="audition-0"]').trigger('click');
    const emitted = wrapper.emitted('audition');
    expect(emitted).toBeTruthy();
    expect(emitted![0]![0]).toMatchObject({ start: 1, end: 4 });
    expect(emitted![0]![1]).toBe(0);
    const playing = mountCrop({ auditionIndex: 0, start: 1, end: 4 });
    await playing.get('[data-testid="audition-0"]').trigger('click');
    expect(playing.emitted('stopAudition')).toBeTruthy();
  });

  it('选用候选会把候选时间写回滑块，之后仍可用 ±0.1s 微调', async () => {
    const wrapper = mountCrop();
    await wrapper.get('[data-testid="choose-1"]').trigger('click');
    expect(wrapper.emitted('choose')![0]![0]).toMatchObject({ start: 9.5, end: 11.5 });
    const nudges = wrapper.findAll('.nudge-row button');
    await nudges[1]!.trigger('click'); // 起点 +0.1
    expect(wrapper.emitted('updateStart')![0]![0]).toBeCloseTo(0.1, 5);
  });

  it('无候选时显示手动选段提示与完整滑块，不出现候选列表', () => {
    const wrapper = mountCrop({
      recommendation: { kind: 'silence', candidates: [], gate: 1, message: '整段几乎只有静音或底噪，没有检测到稳定出声的片段，请手动拖选你要保留的位置。' },
    });
    expect(wrapper.find('[data-testid="candidate-list"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="candidate-empty"]').text()).toContain('手动');
    expect(wrapper.find('[data-testid="analyze"]').exists()).toBe(true);
  });

  it('推荐加载中显示分析状态，不闪烁空提示', () => {
    const wrapper = mountCrop({ recommendation: undefined, recommending: true });
    expect(wrapper.get('[data-testid="recommending"]').text()).toContain('能量');
    expect(wrapper.find('[data-testid="candidate-empty"]').exists()).toBe(false);
  });

  it('当前选段试听与停止按钮事件正确', async () => {
    const wrapper = mountCrop();
    await wrapper.get('[data-testid="preview-range"]').trigger('click');
    expect(wrapper.emitted('previewRange')).toBeTruthy();
    const playing = mountCrop({ auditionIndex: -2 });
    expect(playing.get('[data-testid="preview-range"]').text()).toContain('停止');
    await playing.get('[data-testid="preview-range"]').trigger('click');
    expect(playing.emitted('stopAudition')).toBeTruthy();
  });

  it('波形柱数量跟随后台 peaks，选中区间外的柱体降透明', () => {
    const peaks = Array.from({ length: 100 }, (_, i) => (i > 30 && i < 60 ? 0.8 : 0.1));
    const wrapper = mountCrop({ profile: { duration: 14, sampleRate: 16000, hop: 0.025, levels: new Float32Array(10), peaks } });
    const bars = wrapper.findAll('.timeline-bars i');
    expect(bars).toHaveLength(100);
    expect(bars[45]!.attributes('style')).toContain('opacity: 1');
  });
});
