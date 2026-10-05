// Controlled data transport for full-app tests; no media or real WebRTC is simulated.
class Events {
  events = new Map();
  on(name, fn) {
    const list = this.events.get(name) ?? [];
    list.push(fn);
    this.events.set(name, list);
    return this;
  }
  off(name, fn) {
    this.events.set(
      name,
      (this.events.get(name) ?? []).filter((f) => f !== fn),
    );
  }
  emit(name, ...args) {
    for (const fn of this.events.get(name) ?? []) fn(...args);
  }
}
class Connection extends Events {
  constructor(owner, peer, metadata = {}) {
    super();
    this.owner = owner;
    this.peer = peer;
    this.metadata = metadata;
    this.open = false;
    this.dataChannel = { bufferedAmount: 0 };
    this.peerConnection = {
      connectionState: "connected",
      addEventListener() {},
      removeEventListener() {},
      getSenders() {
        return [];
      },
    };
  }
  send(data) {
    this.owner.channel.postMessage({
      from: this.owner.id,
      to: this.peer,
      type: "data",
      data,
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.owner.connections.delete(this.peer);
    this.owner.channel.postMessage({
      from: this.owner.id,
      to: this.peer,
      type: "close",
    });
    this.emit("close");
  }
}
export default class Peer extends Events {
  connections = new Map();
  constructor(id) {
    super();
    this.id = typeof id === "string" ? id : crypto.randomUUID();
    (window.testPeers ??= new Set()).add(this);
    window.receiveTestPeerFrame = (message) => {
      for (const peer of window.testPeers) peer.receive(message);
    };
    this.channel = {
      postMessage: (message) => window.sendTestPeerFrame(message),
      close: () => window.testPeers.delete(this),
    };
    setTimeout(() => {
      this.open = true;
      this.emit("open", this.id);
    }, 10);
  }
  connect(peer, options = {}) {
    const conn = new Connection(this, peer, options.metadata);
    this.connections.set(peer, conn);
    setTimeout(
      () =>
        this.channel.postMessage({
          from: this.id,
          to: peer,
          type: "connect",
          metadata: options.metadata,
        }),
      10,
    );
    return conn;
  }
  receive(message) {
    if (message.to !== this.id) return;
    let conn = this.connections.get(message.from);
    if (message.type === "connect") {
      if (conn) return;
      conn = new Connection(this, message.from, message.metadata);
      this.connections.set(message.from, conn);
      this.emit("connection", conn);
      conn.open = true;
      conn.emit("open");
      this.channel.postMessage({
        from: this.id,
        to: message.from,
        type: "ack",
      });
    } else if (message.type === "ack") {
      conn.open = true;
      conn.emit("open");
    } else if (message.type === "data") {
      conn?.emit("data", message.data);
    } else if (message.type === "close") {
      conn?.close();
    }
  }
  destroy() {
    this.destroyed = true;
    for (const conn of [...this.connections.values()]) conn.close();
    this.channel.close();
  }
  reconnect() {}
}
