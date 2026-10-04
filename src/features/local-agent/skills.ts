import { invoke } from '@tauri-apps/api/core'

/**
 * Local agent skills.
 *
 * Skills are loaded from `skills/<skill-name>/SKILL.md` (YAML frontmatter plus
 * an instruction body) by the Rust `list_agent_skills` command, so editing or
 * adding a file is picked up without a rebuild. A skill only shapes the system
 * prompt; it never grants new capabilities.
 */
export type AgentSkill = {
  /** Stable id: the skill's directory name. */
  id: string
  name: string
  description: string
  /** Instruction text appended to the system prompt while the skill is active. */
  instructions: string
  /** Absolute path to the source `SKILL.md`. */
  path: string
}

/** Scan the skills directories on disk. */
export async function loadAgentSkills(): Promise<AgentSkill[]> {
  return invoke<AgentSkill[]>('list_agent_skills')
}

/** The managed directory the app reads (and users can add skills to). */
export async function getSkillsDir(): Promise<string> {
  return invoke<string>('skills_dir')
}
