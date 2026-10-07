import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer, WebSocket } from 'ws';
import { validTicket, validAction, publicUrl, WIDTH, HEIGHT } from './protocol.mjs';

export async function startBrowserService({ port = Number(process.env.PORT || 8080), host = '0.0.0.0', secret = process.env.BROWSER_SIGNING_KEY,
  origins = (process.env.ALLOWED_ORIGINS || 'https://maketogether.dev').split(','), proxy = process.env.EGRESS_PROXY,
  maxSessions = 4, maxClients = 8, idleMs = 120000, lifetimeMs = 3600000, launch = () => chromium.launch({ chromiumSandbox: true,
    ...(proxy ? { proxy: { server: proxy } } : {}), args: ['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }) } = {}) {
  if (!secret || secret.length < 32 || secret.startsWith('replace-')) throw new Error('BROWSER_SIGNING_KEY must have at least 32 characters');
  const sessions = new Map();
  let browserPromise;
  let shuttingDown = false;
  const send = (ws, message) => { if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2_000_000) ws.send(JSON.stringify(message)); };
  const broadcast = (session, message) => { for (const ws of session.clients) send(ws, message); };
  const destroy = async (id) => {
    const session = sessions.get(id); if (!session) return;
    sessions.delete(id); clearTimeout(session.idle); clearTimeout(session.expiry);
    for (const ws of session.clients) { send(ws, { type: 'ended' }); ws.close(1000, 'Session ended'); }
    try { await (await session.ready)?.context.close(); } catch { /* Failed launch is already reported. */ }
  };
  async function create(id, url) {
    const session = { clients: new Set(), queue: Promise.resolve(), pending: 0, frame: null, state: null, idle: null, expiry: null, ready: null };
    sessions.set(id, session);
    session.expiry = setTimeout(() => void destroy(id), lifetimeMs);
    session.ready = (async () => {
      browserPromise ??= launch().catch(error => { browserPromise = undefined; throw error; });
      const browser = await browserPromise;
      if (shuttingDown || !sessions.has(id)) throw new Error('Session closed');
      const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, acceptDownloads: false, serviceWorkers: 'block' });
      try {
        await context.route('**/*', route => publicUrl(route.request().url()) ? route.continue() : route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.setDefaultNavigationTimeout(20000);
        page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
        context.on('page', popup => {
          if (popup === page) return;
          void (async () => { await popup.waitForLoadState('domcontentloaded').catch(() => {}); const target = publicUrl(popup.url()); await popup.close(); if (target) await page.goto(target, { waitUntil: 'domcontentloaded' }); })().catch(() => {});
        });
        const cdp = await context.newCDPSession(page);
        const state = async () => {
          const data = { type: 'state', url: page.url(), title: await page.title().catch(() => 'Shared browser'), width: WIDTH, height: HEIGHT };
          session.state = data; broadcast(session, data);
        };
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) void state().catch(() => {}); });
        page.on('domcontentloaded', () => void state().catch(() => {}));
        page.on('crash', () => void destroy(id));
        cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
          void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
          session.frame = { type: 'frame', data }; broadcast(session, session.frame);
        });
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 2 });
        if (publicUrl(url)) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => broadcast(session, { type: 'error', message: 'This page could not be loaded. Try another address.' }));
        await state();
        return { context, page, cdp };
      } catch (error) { await context.close(); throw error; }
    })();
    return session;
  }
  const server = http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'text/plain' }); res.end(req.url === '/health' ? 'ok' : 'Not found'); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16000, perMessageDeflate: false });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, 30000);
  server.on('upgrade', (req, socket, head) => {
    if (shuttingDown || req.url !== '/browser' || !origins.includes(req.headers.origin) || wss.clients.size >= maxSessions * maxClients + 8) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.alive = true; ws.on('pong', () => { ws.alive = true; });
    let session, sessionId, joining = false, count = 0, windowStart = Date.now();
    const authTimeout = setTimeout(() => ws.close(1008, 'Join required'), 5000);
    ws.on('error', () => {});
    ws.on('message', raw => {
      if (Date.now() - windowStart > 1000) { count = 0; windowStart = Date.now(); }
      if (++count > 100) { ws.close(1008, 'Too many commands'); return; }
      let message; try { message = JSON.parse(raw.toString()); } catch { ws.close(1008, 'Invalid message'); return; }
      if (!session) {
        if (joining || !validTicket(message, secret)) { ws.close(1008, 'Invalid session ticket'); return; }
        joining = true; clearTimeout(authTimeout); sessionId = message.session;
        void (async () => {
          session = sessions.get(sessionId);
          if (!session) { if (sessions.size >= maxSessions) { send(ws, { type: 'error', message: 'Shared browsers are busy. Please try again shortly.' }); ws.close(1013); return; } session = await create(sessionId, message.url); }
          if (session.clients.size >= maxClients) { ws.close(1008, 'Session full'); return; }
          clearTimeout(session.idle); session.clients.add(ws);
          await session.ready;
          if (ws.readyState !== WebSocket.OPEN) { session.clients.delete(ws); if (!session.clients.size) session.idle = setTimeout(() => void destroy(sessionId), idleMs); return; }
          send(ws, { type: 'ready', width: WIDTH, height: HEIGHT });
          if (session.state) send(ws, session.state);
          if (session.frame) send(ws, session.frame);
        })().catch(() => { send(ws, { type: 'error', message: 'The shared browser could not start.' }); void destroy(sessionId); ws.close(1011); });
        return;
      }
      if (!session.clients.has(ws) || !validAction(message) || session.pending >= 40) return;
      session.pending++;
      session.queue = session.queue.then(async () => {
        const { page, cdp } = await session.ready;
        const x = Math.round((message.x ?? 0) * (WIDTH - 1)), y = Math.round((message.y ?? 0) * (HEIGHT - 1));
        if (message.type === 'navigate') await page.goto(message.url, { waitUntil: 'domcontentloaded' });
        else if (message.type === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
        else if (message.type === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
        else if (message.type === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
        else if (message.type === 'click') await page.mouse.click(x, y);
        else if (message.type === 'move') await page.mouse.move(x, y);
        else if (message.type === 'scroll') await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: message.dx, deltaY: message.dy });
        else if (message.type === 'text') await page.keyboard.insertText(message.text);
        else if (message.type === 'key') await page.keyboard.press(message.key);
      }).catch(() => send(ws, { type: 'error', message: 'That browser action could not finish. Try again.' })).finally(() => session.pending--);
    });
    ws.on('close', () => { clearTimeout(authTimeout); if (!session) return; session.clients.delete(ws); if (!session.clients.size) session.idle = setTimeout(() => void destroy(sessionId), idleMs); });
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  return { server, sessions, async close() { shuttingDown = true; clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); await Promise.all([...sessions.keys()].map(destroy)); const browser = await browserPromise?.catch(() => undefined); await browser?.close(); await new Promise(resolve => server.close(resolve)); wss.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.EGRESS_PROXY) throw new Error('EGRESS_PROXY is required; run with the isolated Docker Compose network');
  const service = await startBrowserService();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void service.close().then(() => process.exit(0)));
}
