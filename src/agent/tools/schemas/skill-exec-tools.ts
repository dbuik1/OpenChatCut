import type { AgentToolSchema } from '../../tool-schema';

export const RUN_SKILL_SCRIPT_TOOL_NAMES = new Set(['run_skill_script']);

export const RUN_SKILL_SCRIPT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'run_skill_script',
    description: 'Run a script from an installed skill directory on this machine (allowlisted commands: bash/sh/node/npm/python3/python/ffmpeg/ffprobe/mkdir/cp/chmod; npm is limited to run/run-script/start/test; npx, uv, uvx and pip are always rejected), with the working directory locked to that skill directory. Every call needs the user to confirm this command in OpenChatCut, and there is no "always allow". Use it for the deterministic scripts a skill ships with, such as render.mjs or check-deps.sh; the cloud sandbox cannot reach local skill files. The timeout defaults to 60s and is capped at 120s; output is capped at 512KB.',
    input_schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill slug (the skill field returned by load_skill).' },
        command: { type: 'string', description: 'Command to run; its first word must be an allowlisted executable — e.g. bash scripts/check-deps.sh or node scripts/render.mjs.' },
        timeout: { type: 'number', description: 'Optional: timeout in milliseconds. Defaults to 60000, capped at 120000.' },
      },
      required: ['skill', 'command'],
    },
  },
];
