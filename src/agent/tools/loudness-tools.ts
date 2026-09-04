export { LOUDNESS_TOOL_SCHEMAS, LOUDNESS_TOOL_NAMES } from './schemas/loudness-tools';
import type { AgentContext } from '../context';
import { clipLoudnessRange, gainForTarget, isNoAudioLoudnessError, measureClipLoudness } from '../../audio/loudness';

// normalize_loudness - Normalize loudness (target default -14 LUFS, streaming platform standard).
// The naming style is the same as isolate_voice/edit_captions(verb_noun).
//
// Measured by the server's ffmpeg loudnorm route over each clip's trimmed range
// (src/audio/loudness.ts). No new store actions - the resulting gain reuses the
// existing `setItemVolume` command, since normalization here is "calculating the
// correct volume".

type Args = Record<string, unknown>;

const DEFAULT_TARGET_LUFS = -14;

/**
 * Clips whose audio can be normalized: the one named by itemId (prefix
 * matching), otherwise every clip on the timeline that carries audio.
 *
 * Video clips count. Commentary and dialogue usually live on the video clip's
 * own track rather than a separate audio clip, and excluding them made the tool
 * silently do nothing on the footage it was most needed for.
 */
function findAudioItems(ctx: AgentContext, itemId: unknown) {
  const audioItems = ctx.getState().items.filter((it) => it.kind === 'audio' || it.kind === 'video');
  const q = itemId === undefined || itemId === null ? '' : String(itemId);
  if (!q) return audioItems;
  const match = audioItems.find((it) => it.id === q || it.id.startsWith(q));
  return match ? [match] : [];
}

export async function execLoudnessTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'normalize_loudness') return { error: `unknown tool ${name}` };

  const target = typeof args.target === 'number' && Number.isFinite(args.target) ? args.target : DEFAULT_TARGET_LUFS;
  const items = findAudioItems(ctx, args.itemId);
  if (items.length === 0) {
    return args.itemId
      ? { error: `no clip with audio ${args.itemId}` }
      : { ok: true, normalized: [], target, note: 'timeline 上没有带音频的片段' };
  }

  const normalized: { itemId: string; measuredLufs: number; gain: number }[] = [];
  const skipped: { itemId: string; note: string; noAudio?: boolean }[] = [];

  const fps = ctx.getState().fps;
  for (const item of items) {
    const range = clipLoudnessRange(item, fps);
    if (!range) {
      skipped.push({ itemId: item.id, note: 'no src' }); // A clip with no source cannot be measured; skipping is not an error
      continue;
    }
    try {
      const { integratedLufs } = await measureClipLoudness(range);
      const gain = gainForTarget(integratedLufs, target);
      ctx.commands.setItemVolume(item.id, gain); // Reuse existing commands without adding reducer actions
      normalized.push({ itemId: item.id, measuredLufs: integratedLufs, gain });
    } catch (e) {
      // A clip with no audio track is a fact about the selection, not a
      // measurement that went wrong, and retrying it will never succeed.
      skipped.push(isNoAudioLoudnessError(e)
        ? { itemId: item.id, note: 'no audio track', noAudio: true }
        : { itemId: item.id, note: `响度测量失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return { ok: true, normalized, target, ...(skipped.length > 0 ? { skipped } : {}) };
}
