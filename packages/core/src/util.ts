import crypto from 'node:crypto';

export function hashOf(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
}

export function toMoney(n: unknown): string {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) throw new Error(`Not a number: ${String(n)}`);
  return (Math.round(v * 100) / 100).toFixed(2);
}

export function cents(n: unknown): number {
  return Math.round(Number(n) * 100);
}

export function todayIso(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function maskEmail(e: string): string {
  const [user, domain] = e.split('@');
  if (!domain || !user) return '***';
  return `${user[0]}***@${domain}`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Masks emails and long digit runs anywhere in a JSON-able value. */
export function redact<T>(value: T, opts: { emails?: boolean } = { emails: true }): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key && /secret|token|password|authorization/i.test(key)) return '[redacted]';
      let s = v;
      if (opts.emails !== false) s = s.replace(EMAIL_RE, (m) => maskEmail(m));
      return s;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  return walk(value) as T;
}

export function splitName(full: string): { given_name: string; surname: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { given_name: parts[0] ?? '', surname: '' };
  return { given_name: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] ?? '' };
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly quiet = process.env.RETROFIT_QUIET === '1',
  ) {}
  info(msg: string, extra?: unknown) {
    if (!this.quiet)
      console.error(
        `[${this.scope}] ${msg}${extra !== undefined ? ' ' + JSON.stringify(redact(extra)) : ''}`,
      );
  }
  warn(msg: string, extra?: unknown) {
    console.error(
      `[${this.scope}] WARN ${msg}${extra !== undefined ? ' ' + JSON.stringify(redact(extra)) : ''}`,
    );
  }
  child(scope: string) {
    return new Logger(`${this.scope}:${scope}`, this.quiet);
  }
}

export const log = new Logger('retrofit');
