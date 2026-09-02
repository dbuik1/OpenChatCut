import type { AgentToolSchema } from '../../tool-schema';

export const FONT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'search_fonts',
    description: [
      'Search the font catalog the local/headless renderer can load (Google Fonts bundled in-app',
      '+ locally bundled Chinese foundry faces, source:"bundled"). Use when export reports unsupported',
      'fonts or when picking fontFamily for motion-graphic items / captions. Returns canonical family',
      'names to use verbatim. Substring-matches family AND native-name aliases',
      '(case/punctuation-insensitive) — e.g. "inter", "playfair", "noto sc". A Chinese foundry face',
      'matches on its native name as well as its romanised one, so Source Han Sans, Deyi Hei and',
      'Douyin Meihaoti are all reachable either way. loadable=false means catalogued only; prefer a',
      'loadable alternative or confirmFontFallback on export.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to match against font family names or native-name aliases.',
        },
        projectId: {
          type: 'string',
          description: 'Ignored; the active project is used.',
        },
      },
      required: ['query'],
    },
  },
];

export const FONT_TOOL_NAMES = new Set(FONT_TOOL_SCHEMAS.map((t) => t.name));
