import { useToastStore } from '../stores/toastStore'

export function ToastStack(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  if (toasts.length === 0) return <></>
  return (
    <div className="toast-stack" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
