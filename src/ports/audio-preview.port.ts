/** 片段试听：播放器拿到的是裁剪端口产出的 Blob，保证“听到的就是会保存的” */
export interface AudioPreviewPort {
  play(blob: Blob): Promise<void>;
  stop(): void;
}
