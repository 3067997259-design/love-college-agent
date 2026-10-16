import card from './taozi.zh.json'

/**
 * 内置桃子的角色卡：名字和人设正文。正文在 taozi.zh.json，归 Claude 线、用户把关，代码只引用。
 * 导入的角色包有自己的 character/definition 记录；内置角色没有，聊天和日记都回退到这里。
 */
export const BUILTIN_CARD = { name: card.name, persona: card.persona.join('\n\n') } as const
