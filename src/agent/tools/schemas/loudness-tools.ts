import type { AgentToolSchema } from '../../tool-schema';

export const LOUDNESS_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'normalize_loudness',
    description:
      'Normalize clip(s) to a target integrated loudness (LUFS) by measuring the trimmed range of each clip with ffmpeg loudnorm and applying the computed gain as the clip volume. Works on video clips as well as audio clips, so commentary on a video track is included. Defaults to -14 LUFS (streaming loudness standard). To normalize MANY/all clips, call this ONCE with NO itemId — a single call processes every clip with audio on the active timeline and returns per-clip results ({itemId, measuredLufs, gain}). Do NOT call it once per clip. Pass itemId ONLY to normalize a single specific clip.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'number', description: 'Target integrated loudness in LUFS (default -14).' },
        itemId: { type: 'string', description: 'Normalize only this clip (prefix id ok). Omit to normalize every clip with audio.' },
      },
    },
  },
];

export const LOUDNESS_TOOL_NAMES = new Set(LOUDNESS_TOOL_SCHEMAS.map((t) => t.name));
