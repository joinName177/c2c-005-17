import type { AudioProfile } from '../core/candidate-recommender';

/**
 * 只读取音频、产出能量曲线，绝不重采样或改写原音频；
 * 推荐结果只是一组时间标记，真正裁剪仍由 AudioCropperPort 完成。
 */
export interface AudioProfilerPort {
  profile(blob: Blob): Promise<AudioProfile>;
}
