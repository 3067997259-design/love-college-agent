import type { ReactNode } from 'react'
import './work.css'

/** A short notice in the book: what failed or what waits for you. */
export function Notice({ children, live = true }: { children: ReactNode; live?: boolean }) {
  return <p className="work-notice" role={live ? 'alert' : undefined}><span className="notice-mark" aria-hidden>！</span><span>{children}</span></p>
}
