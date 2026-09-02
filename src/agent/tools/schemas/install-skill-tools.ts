import type { AgentToolSchema } from '../../tool-schema';


export const INSTALL_SKILL_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'install_skill',
    description: 'Install a skill repository from GitHub into the local skills directory (~/.openchatcut/skills/<slug>/), installing SKILL.md in full together with its references/scripts/assets/examples. Once installed it shows up automatically in the library\'s Skills panel, and can be activated with /skill:<slug> or from that panel. repo accepts a GitHub URL or owner/repo (e.g. "Jane-xiaoer/paper-collage-ad-codex"). slug is optional and defaults to the name in SKILL.md or the repository name. This installs third-party code: every call needs the user to confirm the repository in OpenChatCut, and there is no "always allow".',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository: a full URL (https://github.com/owner/repo) or owner/repo.' },
        slug: { type: 'string', description: 'Optional: the install directory name, which must be kebab-case. Defaults to the SKILL.md frontmatter name or the repository name.' },
      },
      required: ['repo'],
    },
  },
];

export const INSTALL_SKILL_TOOL_NAMES = new Set(INSTALL_SKILL_TOOL_SCHEMAS.map((t) => t.name));
