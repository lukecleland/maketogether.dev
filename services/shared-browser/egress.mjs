import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import ipaddr from 'ipaddr.js';

export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export async function resolvePublic(hostname, resolver = lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await resolver(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Private destination');
  return addresses[0].address; // Connect to this validated IP, never resolve again.
}
export function startEgress({ port = Number(process.env.PORT || 8081), host = '0.0.0.0', resolve = resolvePublic } = {}) {
  const proxy = http.createServer(async (req, res) => {
    let upstream;
    try {
      const target = new URL(req.url);
      if (target.protocol !== 'http:' || target.username || target.password || (target.port && target.port !== '80')) throw new Error('Invalid destination');
      const address = await resolve(target.hostname);
      const headers = { ...req.headers, host: target.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      upstream = http.request({ hostname: address, port: 80, path: target.pathname + target.search, method: req.method, headers }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
    } catch { res.writeHead(403); res.end('Destination unavailable'); }
  });
  proxy.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    try {
      const target = new URL(`https://${req.url}`);
      if ((target.port && target.port !== '443') || target.username || target.password || target.pathname !== '/') throw new Error('Invalid tunnel');
      const address = await resolve(target.hostname);
      if (client.destroyed) return;
      const upstream = net.connect({ host: address, port: 443 });
      upstream.on('error', () => client.destroy());
      upstream.setTimeout(60000, () => upstream.destroy());
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  proxy.on('upgrade', (_req, socket) => socket.destroy());
  proxy.requestTimeout = 30000; proxy.headersTimeout = 10000;
  proxy.listen(port, host); return proxy;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startEgress();
