import { createContext, useContext, useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const ToastTarget = createContext<HTMLElement | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <ToastTarget.Provider value={target}>
    {children}
    <div ref={setTarget} data-canvas-chrome aria-label="Notifications"
      className="pointer-events-none fixed left-1/2 z-[1100] flex max-h-[50dvh] w-max max-w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-2 overflow-y-auto"
      style={{ top: 'calc(var(--session-header-height, 3rem) + env(safe-area-inset-top) + 0.5rem)' }} />
  </ToastTarget.Provider>;
}

interface ToastProps {
  message?: string | null;
  label: string;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
  status?: boolean;
}

export function Toast(props: ToastProps) {
  return props.message ? <TimedToast key={props.message} {...props} /> : null;
}

function TimedToast({ message, label, onDismiss, action, status }: ToastProps) {
  const target = useContext(ToastTarget);
  const [visible, setVisible] = useState(true);
  const expire = useEffectEvent(() => { setVisible(false); onDismiss?.(); });
  useEffect(() => {
    const timer = setTimeout(() => expire(), 10_000);
    return () => clearTimeout(timer);
  }, []);
  if (!target || !visible) return null;
  return createPortal(<div data-canvas-chrome role={status ? 'status' : 'alert'} aria-label={label}
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
    className="pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-amber-700 bg-zinc-950 px-3 py-2 text-xs text-amber-200 shadow-lg">
    <div className="min-w-0 flex-1 break-words"><p>{message}</p>
      {action && <button type="button" className="mt-1 underline hover:text-white" onClick={action.onClick}>{action.label}</button>}
    </div>
    <button type="button" aria-label={`Dismiss ${label.toLowerCase()}`} onClick={() => { setVisible(false); onDismiss?.(); }}
      className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-white">
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" d="m6 6 12 12M18 6 6 18" /></svg>
    </button>
  </div>, target);
}
