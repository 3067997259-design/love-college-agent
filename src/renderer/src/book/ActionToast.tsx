/** A short-lived action receipt at the edge of the book; never pushes the page around. */
export function ActionToast({ children, actions = [], duration = 8000, onClose }: {
  children: React.ReactNode
  actions?: readonly { label: string; onClick(): void }[]
  duration?: number
  onClose(): void
}) {
  return <div className="action-toast" role="status" aria-live="polite"
    style={{ animationDuration: `${duration}ms` }} onAnimationEnd={onClose}>
    <span>{children}</span>
    <span className="action-toast-actions">
      {actions.map(action => <button key={action.label} type="button" onClick={action.onClick}>{action.label}</button>)}
      <button type="button" className="action-toast-close" aria-label="关闭提示" onClick={onClose}>×</button>
    </span>
  </div>
}
