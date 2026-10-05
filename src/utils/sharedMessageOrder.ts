/** Lamport revisions make concurrent edits converge without trusting device clocks. */
interface Revision { clock: number; source: string }
type Message = Record<string, unknown>;
export class SharedMessageOrder {
  private clock = 0;
  private revisions = new Map<string, Revision>();
  private imported: Revision | null = null;
  private removed = new Set<string>();

  private key(message: Message, source: string): string | null {
    const id = message.id === 'local' ? `remote-peer:${source}` : String(message.id ?? '');
    switch (message.type) {
      case 'panel-update': case 'panel-announce': return `geometry:${id}`;
      case 'note-update': case 'code-update': case 'audio-theme': case 'pdf-page':
      case 'browser-load': case 'browser-scroll': case 'dock-rename':
      case 'text-edit': case 'text-move': return `${message.type}:${id}`;
      case 'load': return `youtube-video:${id}`;
      case 'play': case 'pause': case 'seek': return `youtube:${id}`;
      case 'audio-play': case 'audio-pause': case 'audio-seek': return `audio:${id}`;
      case 'recording-select': case 'recording-play': case 'recording-pause': case 'recording-seek': return `recording:${id}`;
      default: return null;
    }
  }

  stamp(message: Message, source: string): Message {
    const stamped = { ...message, __sharedClock: ++this.clock };
    this.accept(stamped, source);
    return stamped;
  }

  accept(message: Message, source: string): boolean {
    const clock = message.__sharedClock;
    if (typeof clock !== 'number' || !Number.isSafeInteger(clock) || clock < 1) return true; // Legacy peer.
    this.clock = Math.max(this.clock, clock);
    if (this.imported && (clock < this.imported.clock || (clock === this.imported.clock && source <= this.imported.source))) return false;
    if (message.type === 'room-state-import') {
      this.imported = { clock, source };
      this.removed.clear();
      this.revisions.clear();
      return true;
    }
    const id = typeof message.id === 'string' ? message.id : '';
    if (message.type === 'remove-panel') { this.removed.add(id); return true; }
    if (this.removed.has(id)) return false;
    const key = this.key(message, source);
    if (!key) return true;
    const previous = this.revisions.get(key);
    if (previous && (previous.clock > clock || (previous.clock === clock && previous.source >= source))) return false;
    this.revisions.set(key, { clock, source });
    return true;
  }
}
