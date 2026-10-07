import type { AudioPreviewPort } from '../ports/audio-preview.port';

export class HtmlAudioPreviewAdapter implements AudioPreviewPort {
  private element: HTMLAudioElement | undefined;
  private url: string | undefined;
  private resolvePlay: (() => void) | undefined;

  async play(blob: Blob): Promise<void> {
    this.stop();
    const element = new Audio();
    const url = URL.createObjectURL(blob);
    element.src = url;
    this.element = element;
    this.url = url;
    await new Promise<void>((resolve) => {
      this.resolvePlay = resolve;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.resolvePlay = undefined;
        resolve();
      };
      element.onended = finish;
      element.onerror = finish;
      // pause 事件同时覆盖自然结束与手动停止；ended 先到时用 done 去重
      element.onpause = finish;
      element.play().catch(finish);
    });
  }

  stop(): void {
    const resolve = this.resolvePlay;
    this.resolvePlay = undefined;
    if (this.element) {
      this.element.onended = null;
      this.element.onerror = null;
      this.element.onpause = null;
      this.element.pause();
      this.element = undefined;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = undefined;
    }
    resolve?.();
  }
}
