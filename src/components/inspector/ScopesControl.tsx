import { useEffect, useRef, useState } from 'react';
import { analyzeScopeFields, type ScopeFields } from '../../color/scopes';
import type { CapturedPixels } from '../../color/frameCapture';
import { useT } from '../../i18n/locale';

/**
 * Drawn scopes for the frame under the playhead: luma waveform, RGB parade,
 * vectorscope. Every capture is a server render of the composed frame, so the
 * panel refreshes when the playhead settles rather than on every frame, and
 * only while the disclosure is open.
 */
const SETTLE_MS = 350;
const COLUMNS = 192;
const BINS = 96;
const VECTOR_SIZE = 96;

type Status = { kind: 'idle' } | { kind: 'rendering' } | { kind: 'ready'; frame: number } | { kind: 'error'; message: string };

export function ScopesControl({ frame, captureFrame, revision }: {
  frame: number;
  captureFrame: (frame: number, signal?: AbortSignal) => Promise<CapturedPixels>;
  /** Anything whose change alters the composed picture; the scopes recapture when it changes. */
  revision: unknown;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const paradeRef = useRef<HTMLCanvasElement>(null);
  const vectorRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStatus({ kind: 'rendering' });
      try {
        const pixels = await captureFrame(frame, controller.signal);
        if (controller.signal.aborted) return;
        const fields = analyzeScopeFields(pixels.data, pixels.width, pixels.height, { columns: COLUMNS, bins: BINS, vectorSize: VECTOR_SIZE });
        drawWaveform(waveformRef.current, fields);
        drawParade(paradeRef.current, fields);
        drawVectorscope(vectorRef.current, fields);
        setStatus({ kind: 'ready', frame });
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, frame, revision, captureFrame]);

  const statusText = status.kind === 'rendering' ? t('正在渲染示波器…')
    : status.kind === 'error' ? t('示波器渲染失败：{error}', { error: status.message })
      : status.kind === 'ready' ? t('第 {n} 帧 · 播放头停下时刷新', { n: status.frame })
        : t('播放头停下时刷新');

  return (
    <details className="cc-insp-scopes" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('示波器')}</summary>
      <div className="cc-insp-scopes-body">
        <div className="cc-insp-scopes-row">
          <figure>
            <canvas ref={waveformRef} width={COLUMNS} height={BINS} />
            <figcaption>{t('波形')}</figcaption>
          </figure>
          <figure>
            <canvas ref={paradeRef} width={COLUMNS} height={BINS} />
            <figcaption>{t('分量')}</figcaption>
          </figure>
          <figure className="cc-insp-scopes-vector">
            <canvas ref={vectorRef} width={VECTOR_SIZE} height={VECTOR_SIZE} />
            <figcaption>{t('矢量')}</figcaption>
          </figure>
        </div>
        <div className={`cc-insp-muted${status.kind === 'error' ? ' cc-insp-scopes-error' : ''}`}>{statusText}</div>
      </div>
    </details>
  );
}

const GROUND = [14, 14, 16] as const;
const GRATICULE = [64, 64, 70] as const;

function fillGround(image: ImageData): void {
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = GROUND[0]; data[i + 1] = GROUND[1]; data[i + 2] = GROUND[2]; data[i + 3] = 255;
  }
}

/** Additive trace: intensity 0..1 lifts the pixel toward the trace colour. */
function addTrace(image: ImageData, x: number, y: number, intensity: number, rgb: readonly [number, number, number]): void {
  if (intensity <= 0) return;
  const i = (y * image.width + x) * 4;
  const lift = Math.sqrt(intensity);
  image.data[i] = Math.min(255, image.data[i]! + rgb[0] * lift);
  image.data[i + 1] = Math.min(255, image.data[i + 1]! + rgb[1] * lift);
  image.data[i + 2] = Math.min(255, image.data[i + 2]! + rgb[2] * lift);
}

function graticuleRow(image: ImageData, y: number, x0 = 0, x1 = image.width): void {
  for (let x = x0; x < x1; x += 1) {
    const i = (y * image.width + x) * 4;
    image.data[i] = GRATICULE[0]; image.data[i + 1] = GRATICULE[1]; image.data[i + 2] = GRATICULE[2];
  }
}

/** Column-major field → image, bin 0 at the bottom, one column per pixel column of the field. */
function paintField(image: ImageData, field: Float32Array, fields: ScopeFields, xOffset: number, width: number, rgb: readonly [number, number, number]): void {
  const { columns, bins } = fields;
  for (let px = 0; px < width; px += 1) {
    const column = Math.min(columns - 1, Math.floor((px / width) * columns));
    for (let bin = 0; bin < bins; bin += 1) {
      addTrace(image, xOffset + px, bins - 1 - bin, field[column * bins + bin]!, rgb);
    }
  }
}

function drawWaveform(canvas: HTMLCanvasElement | null, fields: ScopeFields): void {
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return;
  const image = context.createImageData(canvas.width, canvas.height);
  fillGround(image);
  for (const level of [0.25, 0.5, 0.75]) graticuleRow(image, Math.round((1 - level) * (fields.bins - 1)));
  paintField(image, fields.luma, fields, 0, canvas.width, [120, 230, 150]);
  context.putImageData(image, 0, 0);
}

function drawParade(canvas: HTMLCanvasElement | null, fields: ScopeFields): void {
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return;
  const image = context.createImageData(canvas.width, canvas.height);
  fillGround(image);
  const third = Math.floor(canvas.width / 3);
  for (const level of [0.25, 0.5, 0.75]) graticuleRow(image, Math.round((1 - level) * (fields.bins - 1)));
  paintField(image, fields.red, fields, 0, third, [235, 90, 90]);
  paintField(image, fields.green, fields, third, third, [90, 225, 110]);
  paintField(image, fields.blue, fields, third * 2, canvas.width - third * 2, [110, 130, 245]);
  context.putImageData(image, 0, 0);
}

// Targets at 75% saturation, placed by the same Rec.709 Cb/Cr projection the
// field uses, so a colour-bar frame lands its dots inside these boxes.
const VECTOR_TARGETS: ReadonlyArray<{ label: string; r: number; g: number; b: number }> = [
  { label: 'R', r: 1, g: 0, b: 0 }, { label: 'Mg', r: 1, g: 0, b: 1 }, { label: 'B', r: 0, g: 0, b: 1 },
  { label: 'Cy', r: 0, g: 1, b: 1 }, { label: 'G', r: 0, g: 1, b: 0 }, { label: 'Yl', r: 1, g: 1, b: 0 },
];

function vectorTarget(size: number, r: number, g: number, b: number, scale: number): { x: number; y: number } {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const cb = ((b - y) / 1.8556) * scale;
  const cr = ((r - y) / 1.5748) * scale;
  return { x: (cb + 0.5) * (size - 1), y: (0.5 - cr) * (size - 1) };
}

function drawVectorscope(canvas: HTMLCanvasElement | null, fields: ScopeFields): void {
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return;
  const size = fields.vectorSize;
  const image = context.createImageData(size, size);
  fillGround(image);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = fields.vector[y * size + x]!;
      if (v > 0) addTrace(image, x, y, v, [200, 220, 235]);
    }
  }
  context.putImageData(image, 0, 0);
  const centre = (size - 1) / 2;
  context.strokeStyle = `rgb(${GRATICULE.join(',')})`;
  context.lineWidth = 1;
  context.beginPath();
  context.arc(centre, centre, centre - 0.5, 0, Math.PI * 2);
  context.moveTo(0, centre + 0.5); context.lineTo(size, centre + 0.5);
  context.moveTo(centre + 0.5, 0); context.lineTo(centre + 0.5, size);
  context.stroke();
  context.font = '7px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const target of VECTOR_TARGETS) {
    const { x, y } = vectorTarget(size, target.r, target.g, target.b, 0.75);
    context.strokeRect(Math.round(x) - 2.5, Math.round(y) - 2.5, 5, 5);
    context.fillStyle = 'rgb(150,150,160)';
    context.fillText(target.label, Math.round(x), Math.round(y) - 6);
  }
}
