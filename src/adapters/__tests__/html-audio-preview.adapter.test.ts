import { afterEach, describe, expect, it, vi } from 'vitest';
import { HtmlAudioPreviewAdapter } from '../html-audio-preview.adapter';

class FakeAudio {
  src = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onpause: (() => void) | null = null;
  paused = true;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; this.onpause?.(); });
}

afterEach(() => vi.restoreAllMocks());

describe('HtmlAudioPreviewAdapter', () => {
  it('播放 Blob 时创建对象 URL，stop 时暂停并释放 URL', async () => {
    let current: FakeAudio | undefined;
    vi.stubGlobal('Audio', vi.fn(function (this: FakeAudio) { current = new FakeAudio(); return current; }));
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => { const url = `blob:${created.length}`; created.push(url); return url; }), revokeObjectURL: vi.fn((url: string) => revoked.push(url)) });
    const adapter = new HtmlAudioPreviewAdapter();
    const playing = adapter.play(new Blob(['x'], { type: 'audio/wav' }));
    await Promise.resolve();
    expect(created).toHaveLength(1);
    expect(current!.play).toHaveBeenCalledTimes(1);
    adapter.stop();
    await playing;
    expect(current!.pause).toHaveBeenCalled();
    expect(revoked).toEqual(created);
  });

  it('自然结束时播放 Promise 自行 resolve 且 URL 被释放', async () => {
    let current: FakeAudio | undefined;
    vi.stubGlobal('Audio', vi.fn(function (this: FakeAudio) { current = new FakeAudio(); return current; }));
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:end'), revokeObjectURL: vi.fn() });
    const adapter = new HtmlAudioPreviewAdapter();
    const promise = adapter.play(new Blob(['y'], { type: 'audio/wav' }));
    await Promise.resolve();
    current!.onended!();
    await expect(promise).resolves.toBeUndefined();
  });
});
