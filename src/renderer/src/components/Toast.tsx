import { useToastStore } from '../stores/toastStore'
import { Icon, type IconName } from './Icon'
import { S } from '../strings'

const TOAST_ICON: Record<'ok' | 'err' | 'info', IconName> = {
  ok: 'checkCircle',
  err: 'alert',
  info: 'info'
}

/** Toasts — kind-tinted, click (or Enter — real button) to dismiss. */
export function ToastStack(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  if (toasts.length === 0) return <></>
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`toast toast--${t.kind}`}
          onClick={() => dismiss(t.id)}
          title={S.toastDismiss}
        >
          <Icon name={TOAST_ICON[t.kind]} size={16} className="toast__icon" />
          <span className="toast__text">{t.text}</span>
        </button>
      ))}
    </div>
  )
}
