/** 开发用：手写体样张，给用户二选一（美术规格 §6.2）。?view=specimen */
const LINES = ['去邮箱里看看。', '看过邮箱，3 封新邮件。', '《CS2041-第三次作业要求.pdf》交给学校的模型整理，原文不经过我。', '对话 日程 礼物 日记 设置', '10月17日 周六　休息　安静　工作中']
const FONTS = [
  { name: '小赖（Xiaolai SC）', family: "'Xiaolai SC'" },
  { name: 'Long Cang', family: "'Long Cang'" },
  { name: '对照：正文霞鹜文楷', family: "'LXGW WenKai Screen'" },
]

export function Specimen() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)', padding: 48, boxSizing: 'border-box', display: 'grid', gap: 28 }}>
      {FONTS.map((f) => (
        <section key={f.name}>
          <div style={{ font: '14px var(--font-body)', color: 'var(--graphite)', marginBottom: 6 }}>{f.name}</div>
          {LINES.map((line) => (
            <p key={line} style={{ margin: '2px 0', fontFamily: f.family, fontSize: 22, color: 'var(--ink-her)' }}>{line}</p>
          ))}
        </section>
      ))}
    </div>
  )
}
