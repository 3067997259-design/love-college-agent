import type { AgentWorkArea } from '../../shared/collaboration'

/** One vocabulary for her own work and her helpers. LCA tools take precedence. */
export const TEMPLATES: Readonly<Record<string, string>> = {
  read: 'dsh.read', read_image: 'dsh.read', working_directory: 'dsh.read', write: 'dsh.write', edit: 'dsh.edit', glob: 'dsh.search', grep: 'dsh.search',
  pwsh: 'dsh.shell', bash: 'dsh.shell', job_output: 'dsh.shell', job_list: 'dsh.shell', job_kill: 'dsh.shell', web_search: 'dsh.web', web_fetch: 'dsh.web', todo_write: 'dsh.plan',
  get_goal: 'dsh.plan', create_goal: 'dsh.plan', update_goal: 'dsh.plan', exit_plan_mode: 'dsh.plan', skill: 'dsh.skill', subagent: 'dsh.agent', subagent_fork: 'dsh.agent',
  send_message: 'dsh.agent', list_agents: 'dsh.agent', interrupt_agent: 'dsh.agent', workflow: 'dsh.agent', ask_user_question: 'user.ask',
  spawn_teammate: 'dsh.agent', wait_agent: 'dsh.agent', team_task_create: 'dsh.agent', team_task_get: 'dsh.agent', team_task_list: 'dsh.agent', team_task_update: 'dsh.agent',
}
export function toolKind(name: string, lcaTools: ReadonlyMap<string, { templateId: string }>): string {
  return lcaTools.get(name)?.templateId ?? TEMPLATES[name] ?? 'dsh.other'
}
export function workArea(templateId: string | null): AgentWorkArea | null {
  if (['dsh.read', 'dsh.write', 'dsh.edit', 'dsh.shell'].includes(templateId ?? '')) return 'files'
  if (['dsh.search', 'dsh.web', 'dsh.skill'].includes(templateId ?? '')) return 'research'
  if (['dsh.agent', 'dsh.plan'].includes(templateId ?? '')) return 'team'
  return null
}
