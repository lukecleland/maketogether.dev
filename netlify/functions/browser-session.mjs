import { createHash, createHmac } from 'node:crypto';

// Anonymous rooms use an unguessable panel UUID as their browser capability.
export default async function handler(request) {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405);
  const secret = process.env.BROWSER_SIGNING_KEY;
  const endpoint = process.env.BROWSER_SERVICE_URL;
  if (!secret || secret.length < 32 || secret.startsWith('replace-') || !endpoint) return respond({ error: 'Shared browsing is not configured yet.' }, 503);
  try {
    const service = new URL(endpoint);
    if (service.protocol !== 'wss:' || service.username || service.password) throw new Error('Invalid service configuration');
    const raw = await request.text();
    if (raw.length > 1024) return respond({ error: 'Request too large' }, 413);
    const { room, panel } = JSON.parse(raw);
    if (typeof room !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(room) || typeof panel !== 'string' || !/^[a-f0-9-]{36}$/i.test(panel)) return respond({ error: 'Invalid room or panel' }, 400);
    const session = createHash('sha256').update(`${room.toLowerCase()}:${panel}`).digest('hex');
    const expires = Math.floor(Date.now() / 1000) + 120;
    const signature = createHmac('sha256', secret).update(`${session}.${expires}`).digest('hex');
    return respond({ endpoint: service.href, session, expires, signature });
  } catch { return respond({ error: 'Shared browsing could not start.' }, 400); }
}

export const config = {
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
