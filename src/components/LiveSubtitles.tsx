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
  const [visible, setVisible] = useState(true);
  const [sharing, setSharing] = useState(false);
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
    if (!sharing || !microphoneEnabled || !RecognitionAPI) return;
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
      publish(text.slice(-240));
    };
    recognition.onerror = event => {
      if (stopped || event.error === 'no-speech') return;
      stopped = true;
      setError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Speech recognition permission was denied. Allow microphone access and try again.'
        : 'Speech recognition is unavailable. Try sharing captions again.');
      setSharing(false);
    };
    const start = () => {
      if (stopped) return;
      try { recognition.start(); }
      catch { stopped = true; setError('Could not start speech recognition. Try again.'); setSharing(false); }
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
  }, [sharing, microphoneEnabled, connection, updateCue]);

  const nameFor = (id: string) => {
    if (labels[id]) return labels[id];
    if (id === 'local') return 'You';
    const index = participants.findIndex(person => `remote-peer:${person.peerId}` === id);
    return index >= 0 ? `Guest ${index + 1}` : 'Participant';
  };
  return <>
    <div data-canvas-chrome className="subtitle-controls">
      <button aria-label="Subtitle settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>CC</button>
      {settingsOpen && <section aria-label="Subtitle settings" className="subtitle-settings">
        <strong>Live subtitles</strong>
        <label><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} /> Show subtitles</label>
        <label>Text size: {size}px<input aria-label="Subtitle text size" type="range" min="16" max="40" step="2" value={size} onChange={event => {
          const next = Number(event.target.value); setSize(next);
          try { localStorage.setItem('maketogether.subtitleSize', String(next)); } catch { /* Storage is optional. */ }
        }} /></label>
        <div className="subtitle-preview" style={{ fontSize: size }}>Your name: Hello!</div>
        <button aria-pressed={sharing} disabled={!RecognitionAPI} onClick={() => { setError(''); setSharing(value => !value); }}>
          {sharing ? 'Stop sharing my captions' : 'Share my speech as captions'}
        </button>
        <p>{!RecognitionAPI ? 'This browser cannot transcribe speech. You can still view shared captions.' : sharing && !microphoneEnabled ? 'Captions paused — unmute your microphone to continue.' : 'Each speaker must opt in. Your browser may process speech online; captions are shared with this room.'}</p>
        {error && <p role="alert">{error}</p>}
      </section>}
    </div>
    {visible && <div className="live-subtitles" role="region" aria-label="Live subtitles" style={{ fontSize: size }}>
      {Object.entries(cues).filter(([id, text]) => text && (id !== 'local' || (sharing && microphoneEnabled))).slice(-4).map(([id, text]) =>
        <div key={id} className="subtitle-cue"><span>{nameFor(id)}: {text}</span></div>)}
    </div>}
  </>;
}
