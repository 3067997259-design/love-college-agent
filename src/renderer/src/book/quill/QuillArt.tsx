import { useId } from 'react'
import './quill.css'

/**
 * 羽毛笔（美术规格 §2.5、§4）：造型自己设计，不用参考截图里的粉金羽毛和星形装饰。
 * 白羽毛根部透一点她的桃色；握笔处系着和她头发上同一条藏青丝带——缩到很小也认得出是她的笔；
 * 金色笔尖，笔尖一滴桃色墨，是片子里第一个出现的颜色，也是恢复时颜色晕开的地方。
 * 深色描边，浅色纸面上也看得见（体验设计 §7.1）。笔尖在 viewBox 底部正中 (24, 236)。
 */
export function QuillArt({ className, inked = true }: { className?: string; inked?: boolean }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className={className} viewBox="0 0 48 240" aria-hidden>
      <defs>
        <linearGradient id={`${id}-vane`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fffbf6" />
          <stop offset="0.7" stopColor="#fdf1ea" />
          <stop offset="1" stopColor="#f8d5c8" />
        </linearGradient>
        <linearGradient id={`${id}-nib`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#9c7c3c" />
          <stop offset="0.45" stopColor="#e3c785" />
          <stop offset="1" stopColor="#a8873f" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="#4d3f45" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {/* 羽片：右边宽、左边窄，像一片真的飞羽 */}
        <path fill={`url(#${id}-vane)`} d="M24 6 C 34 22, 42 60, 40 98 C 38 122, 32 140, 26 152 L 22 150 C 18 138, 13 118, 12 96 C 10 62, 16 26, 24 6 Z" />
        <path strokeWidth="0.8" opacity="0.65" d="M25 40 Q 33 36, 38 30 M25 62 Q 34 58, 40 52 M25 84 Q 34 80, 40 75 M25 106 Q 33 103, 38 98 M25 126 Q 31 124, 34 120 M23 50 Q 16 46, 13 41 M23 74 Q 15 70, 12 64 M23 98 Q 16 95, 13 90 M23 120 Q 18 118, 15 114" />
        {/* 羽片上一道小裂口 */}
        <path strokeWidth="1" d="M40 70 L 33 74 L 40 77" fill="#fdf6f0" />
        <path d="M24 10 L 24 162" />
        {/* 笔尖：金色，中间一道缝，缝头一个小圆孔 */}
        <path fill={`url(#${id}-nib)`} d="M20.5 163 L 27.5 163 L 26.5 196 L 24 234 L 21.5 196 Z" />
        <path strokeWidth="0.9" d="M24 199 L 24 230" />
        <circle cx="24" cy="196" r="1.3" fill="#4d3f45" stroke="none" />
      </g>
      {/* 握笔处的藏青丝带：一圈加一个小蝴蝶结 */}
      <g fill="#2e3350" stroke="#1d2036" strokeWidth="0.8" strokeLinejoin="round">
        <rect x="20" y="150" width="8" height="14" rx="2" />
        <path d="M21 156 C 13 149, 11 162, 20.5 159 Z" />
        <path d="M27 156 C 35 149, 37 162, 27.5 159 Z" />
        <path d="M22.5 160 L 18.5 172 L 21 171 L 23.5 161 Z M25.5 160 L 29.5 172 L 27 171 L 24.5 161 Z" />
      </g>
      {inked && <circle className="quill-ink" cx="24" cy="235" r="2.8" fill="#e9a28f" stroke="#76382e" strokeWidth="0.8" />}
    </svg>
  )
}
