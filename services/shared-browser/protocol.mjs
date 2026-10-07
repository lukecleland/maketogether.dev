import { createHmac, timingSafeEqual } from 'node:crypto';

export const WIDTH = 1280;
export const HEIGHT = 800;
export function validTicket(value, secret, now = Date.now()) {
  if (!value || value.type !== 'join' || !/^[a-f0-9]{64}$/.test(value.session ?? '') || !/^[a-f0-9]{64}$/.test(value.signature ?? '')) return false;
  if (!Number.isInteger(value.expires) || value.expires * 1000 < now || value.expires * 1000 > now + 180000) return false;
  const expected = createHmac('sha256', secret).update(`${value.session}.${value.expires}`).digest();
  return timingSafeEqual(expected, Buffer.from(value.signature, 'hex'));
}
export function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function validAction(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'navigate') return !!publicUrl(value.url);
  if (['back', 'forward', 'reload'].includes(value.type)) return true;
  if (value.type === 'text') return typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 4096;
  if (value.type === 'key') return ['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'ControlOrMeta+A', 'ControlOrMeta+Z'].includes(value.key);
  if (['click', 'move', 'scroll'].includes(value.type)) {
    if (![value.x, value.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) return false;
    return value.type !== 'scroll' || [value.dx, value.dy].every(n => Number.isFinite(n) && Math.abs(n) <= 1600);
  }
  return false;
}
