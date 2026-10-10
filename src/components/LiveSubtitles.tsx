import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomDataConnection } from '../hooks/usePeer';

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
const RecognitionAPI = (window as unknown as {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
}).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

interface Props {
  connection: RoomDataConnection | null;
  microphoneEnabled: boolean;
  labels: Record<string, string>;
  participants: { peerId: string }[];
}

export function LiveSubtitles({ connection, microphoneEnabled, labels, participants }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsButton.current?.focus();
  }, []);
  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSettings();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settingsOpen, closeSettings]);
  const [enabled, setEnabled] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [size, setSize] = useState(() => {
    try { return Math.min(40, Math.max(16, Number(localStorage.getItem('maketogether.subtitleSize')) || 24)); }
    catch { return 24; }
  });
  const [cues, setCues] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const updateCue = useCallback((id: string, text: string) => {
    clearTimeout(timers.current.get(id));
    setCues(previous => ({ ...previous, [id]: text }));
    if (text) timers.current.set(id, setTimeout(() => {
      setCues(previous => { const next = { ...previous }; delete next[id]; return next; });
      timers.current.delete(id);
    }, 7000));
    else timers.current.delete(id);
  }, []);
  useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(clearTimeout); pending.clear(); };
  }, []);
  useEffect(() => {
    if (!connection) return;
    const receive = (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const message = data as Record<string, unknown>;
      if (message.type !== 'subtitle' || typeof message.__meshSourcePeerId !== 'string' || typeof message.text !== 'string') return;
      // Derive identity from the transport, never from a supplied caption label.
      updateCue(`remote-peer:${message.__meshSourcePeerId}`, message.text.slice(-240));
    };
    connection.on('data', receive);
    return () => connection.off('data', receive);
  }, [connection, updateCue]);
  useEffect(() => {
    if (!enabled || !microphoneEnabled || !RecognitionAPI) return;
    const recognition = new RecognitionAPI();
    let stopped = false;
    let restart: ReturnType<typeof setTimeout> | undefined;
    const publish = (text: string) => {
      updateCue('local', text);
      if (connection?.open) connection.send({ type: 'subtitle', text });
    };
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = event => {
      if (stopped) return;
      const text = Array.from(event.results).slice(event.resultIndex).map(result => result[0].transcript).join(' ').trim();
      setError('');
      publish(text.slice(-240));
    };
    recognition.onerror = event => {
      if (stopped || event.error === 'no-speech') return;
      stopped = true;
      setError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Speech recognition permission was denied. Allow microphone access and try again.'
        : 'Speech recognition is unavailable. Retry below or turn CC off and on.');
      clearTimeout(restart);
      recognition.abort();
      publish('');
    };
    const start = () => {
      if (stopped) return;
      try { recognition.start(); }
      catch { stopped = true; setError('Could not start speech recognition. Try again.'); }
    };
    recognition.onend = () => { if (!stopped) restart = setTimeout(start, 1000); };
    start();
    return () => {
      stopped = true;
      clearTimeout(restart);
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
      publish('');
    };
  }, [enabled, microphoneEnabled, connection, updateCue, retry]);

  const nameFor = (id: string) => {
    if (labels[id]) return labels[id];
    if (id === 'local') return 'You';
    const index = participants.findIndex(person => `remote-peer:${person.peerId}` === id);
    return index >= 0 ? `Guest ${index + 1}` : 'Participant';
  };
  return <>
    <div data-canvas-chrome className="subtitle-controls">
      <div className="subtitle-buttons" role="group" aria-label="Caption controls">
        <button className="subtitle-toggle" aria-label="Closed captions" aria-pressed={enabled}
          title={enabled ? 'Turn captions off' : 'Turn captions on and share your speech with this room'}
          onClick={() => { setError(''); setEnabled(value => !value); }}>CC</button>
        <button ref={settingsButton} aria-label="Subtitle settings" title="Subtitle settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path strokeLinejoin="round" d="m9 3-.6 2.4-2.1 1.2L4 6l-2 3.5 1.7 1.8v2.4L2 15.5 4 19l2.3-.6 2.1 1.2L9 22h4l.6-2.4 2.1-1.2 2.3.6 2-3.5-1.7-1.8v-2.4L20 9.5 18 6l-2.3.6-2.1-1.2L13 3Z" />
            <circle cx="11" cy="12.5" r="3" />
          </svg>
        </button>
      </div>
      {enabled && (error || !RecognitionAPI || !microphoneEnabled) && <button className="subtitle-status" onClick={() => setSettingsOpen(true)}>
        {error ? 'Speech unavailable' : !RecognitionAPI ? 'Viewing only' : 'Mic muted'}
      </button>}
      {settingsOpen && <section aria-label="Subtitle settings" className="subtitle-settings">
        <div className="flex items-center justify-between gap-3">
          <strong>Live subtitles</strong>
          <button type="button" aria-label="Close subtitle settings" title="Close subtitle settings" onClick={closeSettings}>×</button>
        </div>
        <label>Text size: {size}px<input aria-label="Subtitle text size" type="range" min="16" max="40" step="2" value={size} onChange={event => {
          const next = Number(event.target.value); setSize(next);
          try { localStorage.setItem('maketogether.subtitleSize', String(next)); } catch { /* Storage is optional. */ }
        }} /></label>
        <div className="subtitle-preview" style={{ fontSize: size }}>Your name: Hello!</div>
        <p>{!RecognitionAPI ? 'This browser cannot transcribe speech. You can still view shared captions.' : enabled && !microphoneEnabled ? 'Captions paused — unmute your microphone to continue.' : 'Turn CC on to show captions and share your speech with this room. Each speaker must enable CC. Your browser may process speech online.'}</p>
        {error && <>
          <p role="alert">{error}</p>
          <button onClick={() => { setError(''); setRetry(value => value + 1); }}>Retry speech recognition</button>
        </>}
      </section>}
    </div>
    {enabled && <div className="live-subtitles" role="region" aria-label="Live subtitles" style={{ fontSize: size }}>
      {Object.entries(cues).filter(([id, text]) => text && (id !== 'local' || (enabled && microphoneEnabled))).slice(-4).map(([id, text]) =>
        <div key={id} className="subtitle-cue"><span>{nameFor(id)}: {text}</span></div>)}
    </div>}
  </>;
}
