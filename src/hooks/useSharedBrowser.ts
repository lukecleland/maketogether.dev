import { useEffect, useEffectEvent, useRef, useState } from 'react';

export type BrowserAction = { type: 'navigate'; url: string } | { type: 'back' | 'forward' | 'reload' }
  | { type: 'click' | 'move'; x: number; y: number } | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { type: 'text'; text: string } | { type: 'key'; key: string };

export function useSharedBrowser(room: string, panel: string, initialUrl: string, onUrlChange: (url: string) => void) {
  const [status, setStatus] = useState<'connecting' | 'ready' | 'closed'>('connecting');
  const [error, setError] = useState('');
  const [frame, setFrame] = useState('');
  const [url, setUrl] = useState(initialUrl);
  const [retry, setRetry] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const initial = useRef(initialUrl);
  const lastUrl = useRef(initialUrl);
  const publishUrl = useEffectEvent(onUrlChange);
  useEffect(() => {
    const controller = new AbortController();
    let ws: WebSocket | null = null;
    let stopped = false;
    const deadline = setTimeout(() => { controller.abort(); ws?.close(); if (!stopped) { setError('The shared browser did not respond. Try reconnecting.'); setStatus('closed'); } }, 30000);
    void (async () => {
      const response = await fetch('/.netlify/functions/browser-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room, panel }), signal: controller.signal });
      const ticket = await response.json();
      if (!response.ok) throw new Error(ticket.error || 'Shared browsing could not start.');
      if (stopped) return;
      setStatus('connecting'); setError(''); setFrame('');
      const endpoint = new URL(ticket.endpoint);
      if (endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname) && location.hostname === endpoint.hostname)) throw new Error('Shared browser connection is not secure.');
      ws = new WebSocket(endpoint.href); socket.current = ws;
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'join', session: ticket.session, expires: ticket.expires, signature: ticket.signature, url: initial.current }));
      ws.onmessage = event => {
        if (stopped) return;
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'ready') { clearTimeout(deadline); setStatus('ready'); setError(''); }
        else if (message.type === 'frame' && typeof message.data === 'string') setFrame(`data:image/jpeg;base64,${message.data}`);
        else if (message.type === 'state' && typeof message.url === 'string' && /^https?:\/\//.test(message.url)) {
          setUrl(message.url); initial.current = message.url;
          if (lastUrl.current !== message.url) { lastUrl.current = message.url; publishUrl(message.url); }
        } else if (message.type === 'error') setError(message.message || 'Shared browser error.');
        else if (message.type === 'ended') { setStatus('closed'); setError('This shared browser session has ended. Reconnect to start a fresh session.'); }
      };
      ws.onerror = () => { if (!stopped) setError('The shared browser connection failed. Try reconnecting.'); };
      ws.onclose = () => { clearTimeout(deadline); if (!stopped) setStatus('closed'); };
    })().catch(cause => { clearTimeout(deadline); if (!stopped) { setError(cause instanceof Error ? cause.message : 'Shared browsing could not start.'); setStatus('closed'); } });
    return () => { stopped = true; clearTimeout(deadline); controller.abort(); socket.current = null; ws?.close(); };
  }, [room, panel, retry]);
  const send = (action: BrowserAction) => {
    if (status === 'ready' && socket.current?.readyState === WebSocket.OPEN && socket.current.bufferedAmount < 64000) socket.current.send(JSON.stringify(action));
  };
  return { status, error, frame, url, send, reconnect: () => { setStatus('connecting'); setError(''); setRetry(value => value + 1); } };
}
