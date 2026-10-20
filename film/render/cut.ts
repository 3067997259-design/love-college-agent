/** 一段片子：按时刻画一帧。帧要按顺序画（笔触和事件是累积的），同样的顺序永远出同样的画面 */
export interface Cut {
  duration: number
  frame(t: number): void
}

export interface Box { x: number; y: number; width: number; height: number }

/** 从应用书页截下来的位置（设计像素 1920×1080），film/render.mjs plates 生成 */
export interface Layout { room: Box; card: Box; gutter: number; pageLeft: Box; pageRight: Box }

export interface Assets {
  /** 仓库里的相对路径 → 页面能取的地址 */
  url(path: string): string
  layout: Layout
  /** film/cuts.json 里这一段用的图（帧 id → 仓库相对路径） */
  art: Record<string, string>
}
