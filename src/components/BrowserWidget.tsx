import { flushSync } from 'react-dom';
import { useRef, useState } from 'react';
import { BROWSER_ENABLED } from '../utils/features';
import { DockButton } from './Dock';
import { normaliseBrowserUrl } from '../utils/browserUrl';
import { useSharedBrowser } from '../hooks/useSharedBrowser';

interface BrowserProps {
  roomCode: string;
  panelId: string;
  initialUrl?: string;
  onClose?: () => void;
  docked?: boolean;
  onToggleDock?: () => void;
  onUrlChange: (url: string) => void;
  title?: string;
}
export function BrowserWidget(props: BrowserProps) {
  return <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950" data-browser-root>
    <div className="drag-handle flex shrink-0 cursor-grab items-center justify-between gap-2 bg-zinc-800 px-2 py-1.5">
      <span className="truncate text-xs font-semibold text-sky-300">{props.title ?? 'Shared browser'}</span>
      <div className="flex items-center gap-1">
        {props.onToggleDock && <DockButton docked={props.docked ?? false} onToggle={props.onToggleDock} />}
        {props.onClose && <button onClick={props.onClose} aria-label="Close browser" className="px-2 text-zinc-400 hover:text-red-400">×</button>}
      </div>
    </div>
    {BROWSER_ENABLED ? <SharedBrowser {...props} /> : <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-zinc-400">Shared browsing is being upgraded. Use Share screen for now.</div>}
  </div>;
}
function SharedBrowser({ roomCode, panelId, initialUrl = '', onUrlChange }: BrowserProps) {
  const browser = useSharedBrowser(roomCode, panelId, initialUrl, onUrlChange);
  const [draft, setDraft] = useState({ url: initialUrl, text: initialUrl });
  const [inputError, setInputError] = useState('');
  const [typing, setTyping] = useState(false);
  const surface = useRef<HTMLImageElement>(null);
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const lastMove = useRef(0);
  const ready = browser.status === 'ready';
  const value = draft.url === browser.url ? draft.text : browser.url;
  const point = (x: number, y: number) => {
    const rect = surface.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (x - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (y - rect.top) / rect.height)) };
  };
  const navigate = () => {
    const url = normaliseBrowserUrl(value);
    if (!url) { setInputError('Enter a valid website address.'); return; }
    setInputError(''); browser.send({ type: 'navigate', url });
  };
  const button = 'h-7 min-w-7 rounded px-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40';
  return <>
    <form className="flex shrink-0 items-center gap-1 border-b border-zinc-800 p-1" onSubmit={event => { event.preventDefault(); navigate(); }}>
      <button type="button" className={button} disabled={!ready} aria-label="Back in shared browser" onClick={() => browser.send({ type: 'back' })}>←</button>
      <button type="button" className={button} disabled={!ready} aria-label="Forward in shared browser" onClick={() => browser.send({ type: 'forward' })}>→</button>
      <button type="button" className={button} disabled={!ready} aria-label="Reload shared browser" onClick={() => browser.send({ type: 'reload' })}>↻</button>
      <input aria-label="Browser URL" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={value} onChange={event => setDraft({ url: browser.url, text: event.target.value })} placeholder="Enter a website…" className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-white" />
      <button className={button} disabled={!ready} type="submit">Go</button>
      <button type="button" className={button} disabled={!ready} aria-label="Type in shared browser" aria-pressed={typing} onClick={() => { flushSync(() => setTyping(true)); input.current?.focus(); }}>⌨</button>
    </form>
    <div className="shrink-0 px-2 py-1 text-[10px] text-zinc-400" role="status">{ready ? 'Shared browser · everyone can control' : browser.status === 'connecting' ? 'Connecting to shared browser…' : 'Shared browser disconnected'}</div>
    {(browser.error || inputError) && <div role="alert" className="shrink-0 px-2 py-1 text-xs text-amber-300">{inputError || browser.error}</div>}
    {browser.status === 'closed' && <button className="m-2 rounded bg-sky-700 px-3 py-2 text-sm text-white" onClick={browser.reconnect}>Reconnect browser</button>}
    {typing && <div className="flex shrink-0 gap-1 p-1">
      <input ref={input} aria-label="Text for shared browser" maxLength={4096} placeholder="Type into the selected field" className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 text-sm text-white" autoCapitalize="none" autoCorrect="off" onKeyDown={event => { if (event.key === 'Enter') { if (event.currentTarget.value) browser.send({ type: 'text', text: event.currentTarget.value }); event.currentTarget.value = ''; browser.send({ type: 'key', key: 'Enter' }); } }} />
      <button className={button} onClick={() => { if (input.current?.value) { browser.send({ type: 'text', text: input.current.value }); input.current.value = ''; } }}>Send</button>
      <button className={button} aria-label="Backspace in shared browser" onClick={() => browser.send({ type: 'key', key: 'Backspace' })}>⌫</button>
      <button className={button} aria-label="Close browser keyboard" onClick={() => setTyping(false)}>×</button>
    </div>}
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-zinc-950">
      {browser.frame ? <img ref={surface} src={browser.frame} alt="Shared browser page" draggable={false} tabIndex={0} className="max-h-full max-w-full touch-none select-none outline-none focus:ring-1 focus:ring-sky-500" style={{ opacity: ready ? 1 : 0.45 }}
        onPointerDown={event => { if (!ready) return; event.currentTarget.focus(); gesture.current = { x: event.clientX, y: event.clientY, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          if (!ready) return;
          if (event.pointerType === 'mouse') {
            if (Date.now() - lastMove.current > 50) { lastMove.current = Date.now(); browser.send({ type: 'move', ...point(event.clientX, event.clientY) }); }
            return;
          }
          const start = gesture.current;
          if (!start) return;
          const dx = start.x - event.clientX, dy = start.y - event.clientY;
          if (!start.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
          const rect = event.currentTarget.getBoundingClientRect();
          browser.send({ type: 'scroll', ...point(event.clientX, event.clientY), dx: Math.max(-1600, Math.min(1600, dx * 1280 / rect.width)), dy: Math.max(-1600, Math.min(1600, dy * 800 / rect.height)) });
          gesture.current = { x: event.clientX, y: event.clientY, moved: true };
        }}
        onPointerUp={event => { if (gesture.current && !gesture.current.moved) browser.send({ type: 'click', ...point(event.clientX, event.clientY) }); gesture.current = null; }}
        onPointerCancel={() => { gesture.current = null; }}
        onWheel={event => { event.stopPropagation(); browser.send({ type: 'scroll', ...point(event.clientX, event.clientY), dx: Math.max(-1600, Math.min(1600, event.deltaX)), dy: Math.max(-1600, Math.min(1600, event.deltaY)) }); }}
        onPaste={event => { event.preventDefault(); event.stopPropagation(); const text = event.clipboardData.getData('text').slice(0, 4096); if (text) browser.send({ type: 'text', text }); }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.metaKey || event.ctrlKey) { if (['a', 'z'].includes(event.key.toLowerCase())) { event.preventDefault(); browser.send({ type: 'key', key: `ControlOrMeta+${event.key.toUpperCase()}` }); } return; }
          if (event.key.length === 1) { event.preventDefault(); browser.send({ type: 'text', text: event.key }); }
          else if (['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) { event.preventDefault(); browser.send({ type: 'key', key: event.key }); }
        }} /> : <p className="p-4 text-center text-sm text-zinc-500">{ready ? 'Enter a website address to browse together.' : 'Waiting for the shared browser…'}</p>}
    </div>
  </>;
}
