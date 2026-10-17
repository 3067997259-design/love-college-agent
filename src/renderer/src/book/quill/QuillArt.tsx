import { useId } from 'react'
import './quill.css'

/**
 * 羽毛笔（美术规格 §2.5、§4）：造型自己设计，不用参考截图里的粉金羽毛和星形装饰。
 * 白羽毛根部透一点她的桃色；握笔处系着和她头发上同一条藏青丝带——缩到很小也认得出是她的笔；
 * 金色笔尖，笔尖一滴桃色墨，是片子里第一个出现的颜色，也是恢复时颜色晕开的地方。
 * 深色描边，浅色纸面上也看得见（体验设计 §7.1）。笔尖在 viewBox 底部正中 (24, 236)。
 *
 * 2026-10-17 晚按用户意见重画一版：羽片加宽、羽枝和裂口更清楚，丝带蝴蝶结加大并加金色笔箍，
 * 金色笔尖加高光与呼吸孔；仍是同一支笔、同一套配色，不改语义（存档入口）。
 */
export function QuillArt({ className, inked = true }: { className?: string; inked?: boolean }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className={className} viewBox="0 0 48 240" aria-hidden>
      <defs>
        <linearGradient id={`${id}-vane`} x1="0.2" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#fffdf9" />
          <stop offset="0.55" stopColor="#fdf2e9" />
          <stop offset="0.85" stopColor="#fae2d5" />
          <stop offset="1" stopColor="#f6cdbd" />
        </linearGradient>
        <linearGradient id={`${id}-shade`} x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0" stopColor="#efc9b8" stopOpacity="0" />
          <stop offset="1" stopColor="#e6ac97" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id={`${id}-nib`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#96763a" />
          <stop offset="0.4" stopColor="#eed49a" />
          <stop offset="0.62" stopColor="#d9b66f" />
          <stop offset="1" stopColor="#a5853f" />
        </linearGradient>
        <linearGradient id={`${id}-ribbon`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3a4063" />
          <stop offset="1" stopColor="#252a45" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="#4d3f45" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        {/* 羽片：右边宽、左边窄，边缘带两个小裂口，像一片真的飞羽 */}
        <path fill={`url(#${id}-vane)`} d="M24 4 C 33 16, 41 42, 42 74 C 43 104, 39 130, 32 148 C 30 154, 27 160, 24 162 C 22 158, 18 150, 15 138 C 10 120, 8 96, 10 70 C 12 44, 17 20, 24 4 Z" />
        <path fill={`url(#${id}-shade)`} stroke="none" d="M24 12 C 31 28, 36 50, 37 74 C 38 100, 35 124, 30 142 C 28 148, 26 154, 24 158 L 24 12 Z" />
        {/* 羽枝：从羽轴向两侧斜上展开 */}
        <g strokeWidth="0.55" opacity="0.5">
          <path d="M24.4 30 Q 31 27, 35 22 M24.4 46 Q 32 43, 37 36 M24.4 62 Q 33 58, 39 50 M24.4 78 Q 33 74, 39 66 M24.4 94 Q 32 90, 38 82 M24.4 110 Q 31 107, 36 99 M24.4 126 Q 30 123, 33 116 M23.6 38 Q 17 36, 13 31 M23.6 54 Q 16 52, 12 46 M23.6 70 Q 16 68, 12 62 M23.6 86 Q 16 84, 12 78 M23.6 102 Q 17 100, 14 94 M23.6 118 Q 18 116, 16 110" />
        </g>
        {/* 外边的小裂口：填回纸色，像羽毛被风掀起的一角 */}
        <path fill="#fffdf9" d="M42 58 L 35 62 L 41.5 66" strokeWidth="0.9" />
        <path fill="#fffdf9" d="M41 92 L 34 95.5 L 40.5 99.5" strokeWidth="0.9" />
        {/* 羽轴 */}
        <path strokeWidth="1.05" d="M24 8 C 23.4 54, 24.6 104, 24 160" />
        {/* 高光：纸面上的一点亮 */}
        <path stroke="#fffdf9" strokeWidth="1.6" opacity="0.7" d="M20.5 22 C 16.5 40, 14.5 66, 15.5 94" />
        {/* 笔尖：金色，中间一道缝，缝头一个呼吸孔；笔端一滴桃色墨 */}
        <path fill={`url(#${id}-nib)`} d="M20.2 163 L 27.8 163 L 26.8 196 L 24 234 L 21.2 196 Z" />
        <path strokeWidth="0.8" d="M24 199 L 24 230" />
        <path stroke="#fff6dd" strokeWidth="0.7" opacity="0.8" d="M22 168 L 22.8 192" />
        <circle cx="24" cy="196" r="1.35" fill="#4d3f45" stroke="none" />
        {/* 笔箍：一小圈金色 */}
        <path fill="#c9a96a" strokeWidth="0.8" d="M20.4 160.5 C 20.4 158.8, 27.6 158.8, 27.6 160.5 C 27.6 162.2, 20.4 162.2, 20.4 160.5 Z" />
      </g>
      {/* 握笔处的藏青丝带：一圈、一个蝴蝶结和两条带子 */}
      <g fill={`url(#${id}-ribbon)`} stroke="#1d2036" strokeWidth="0.75" strokeLinejoin="round">
        <path d="M20 161 C 20 156.5, 28 156.5, 28 161 L 28 171 C 28 175.5, 20 175.5, 20 171 Z" />
        <path d="M20.6 166 C 12 156.5, 7.5 171.5, 19.8 170.2 Z" />
        <path d="M27.4 166 C 36 156.5, 40.5 171.5, 28.2 170.2 Z" />
        <path d="M21.6 170.6 L 16.4 186 L 19.8 185 L 23.2 172 Z" />
        <path d="M26.4 170.6 L 31.6 186 L 28.2 185 L 24.8 172 Z" />
      </g>
      <circle cx="24" cy="168" r="2.3" fill="#3a4063" stroke="#1d2036" strokeWidth="0.7" />
      {inked && <circle className="quill-ink" cx="24" cy="235" r="2.9" fill="#e9a28f" stroke="#76382e" strokeWidth="0.8" />}
    </svg>
  )
}
