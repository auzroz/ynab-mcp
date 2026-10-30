import type { Response } from 'supertest';

/** The `name=value` pairs a response sets, as one `Cookie` request header. */
export function cookieHeaderFrom(res: Response): string {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const pairs = list.map((c) => c.split(';')[0] ?? '').filter((p) => p.length > 0);
  if (pairs.length === 0) throw new Error('response set no cookie');
  return pairs.join('; ');
}
