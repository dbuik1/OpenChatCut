// Frame fetching shared by the agent's inspect_color tool and the inspector's
// drawn scopes: render one timeline frame on the server, decode it in the
// browser, and hand back downsampled RGBA pixels for src/color/scopes.ts.
import type { TimelineState } from '../editor/types';

export interface CapturedPixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Press the long side to this size before counting: enough for full-frame statistics and an order of magnitude less decoding and traversal. */
export const ANALYZE_MAX_EDGE = 320;

/** base64 PNG/JPEG → downsampled RGBA pixels (browser-only: createImageBitmap + canvas). */
export async function decodeBase64Pixels(base64: string): Promise<CapturedPixels> {
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, ANALYZE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d canvas unavailable');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { data: context.getImageData(0, 0, width, height).data, width, height };
}

export async function renderTimelineFrameBase64(state: TimelineState, frame: number, signal?: AbortSignal): Promise<string> {
  const res = await fetch('/render-still', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, frames: [frame], fps: state.fps }),
    signal,
  });
  if (!res.ok) {
    const info = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(info?.error ?? `render-still failed (${res.status})`);
  }
  const data = (await res.json()) as { frames: { frame: number; base64: string }[] };
  const base64 = data.frames?.[0]?.base64;
  if (!base64) throw new Error('render-still returned no frame');
  return base64;
}

/** The composed timeline at one frame, as pixels ready for scope analysis. */
export async function captureTimelineFramePixels(state: TimelineState, frame: number, signal?: AbortSignal): Promise<CapturedPixels> {
  return decodeBase64Pixels(await renderTimelineFrameBase64(state, frame, signal));
}
