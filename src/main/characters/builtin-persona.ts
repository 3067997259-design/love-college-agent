import card from './taozi.zh.json'

/**
 * 内置桃子的角色卡：名字和人设正文。正文在 taozi.zh.json，归 Claude 线、用户把关，代码只引用。
 * 导入的角色包有自己的 character/definition 记录；内置角色没有，聊天和日记都回退到这里。
 */
export const BUILTIN_CARD = { name: card.name, persona: card.persona.join('\n\n') } as const

/** 预算紧的地方给的短人设上限（字符）：展位游戏一轮里每次调用都带着它，按整条请求的字节数计入预算 */
export const BRIEF_PERSONA_CHARS = 400

/**
 * 短人设：内置桃子用写好的短版（taozi.zh.json 的 brief）；导入的角色包取正文开头一段。
 * 整份人设（内置约 1700 字）每次调用都带上，会把展位游戏一轮的用量预算挤爆。
 */
export function briefPersona(character: { id: string; persona: string }): string {
  if (character.id === 'default-character') return card.brief
  return character.persona.slice(0, BRIEF_PERSONA_CHARS)
}
