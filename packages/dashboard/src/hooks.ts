import { useCallback, useEffect, useRef, useState } from 'react';

export function useDark(): boolean {
  const q = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const [dark, setDark] = useState(() =>
    document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : !!q?.matches,
  );
  useEffect(() => {
    if (!q) return;
    const on = () => !document.documentElement.dataset.theme && setDark(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, [q]);
  return dark;
}

/** Loads data and reloads it when the server reports a change (SSE) or on demand. */
export function useLive<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loader = useRef(load);
  loader.current = load;
  const reload = useCallback(() => {
    loader
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(reload, deps);
  useEffect(() => onServerChange(reload), [reload]);
  return { data, error, reload };
}

const listeners = new Set<() => void>();
let source: EventSource | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function onServerChange(fn: () => void) {
  listeners.add(fn);
  if (!source) {
    source = new EventSource('/api/stream');
    source.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'hello') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => listeners.forEach((l) => l()), 250);
    };
  }
  return () => {
    listeners.delete(fn);
  };
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4200);
    return () => clearTimeout(t);
  }, [msg]);
  return { msg, toast: setMsg };
}
