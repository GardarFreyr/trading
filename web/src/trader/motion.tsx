// React wiring for the transitions.dev snippets in ../motion.css.
// Each component follows the "JavaScript orchestration" section of its reference
// file in .agents/skills/transitions-dev, adapted to React refs.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const cssMs = (name: string, fallback: number) => {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
};

/**
 * Number subtle change (36): only the characters that changed cross-fade in place,
 * rising when `value` went up and falling when it went down.
 */
export function SubtleNumber({ text, value, className }: { text: string; value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<{ text: string; value: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const last = prev.current;
    prev.current = { text, value };
    el.setAttribute('aria-label', text);
    if (!last || last.text === text) {
      if (!last) el.textContent = text;
      return;
    }
    const sameLength = last.text.length === text.length;
    el.style.setProperty('--subtle-dir', value >= last.value ? '1' : '-1');
    el.classList.remove('is-animating');
    el.replaceChildren();
    [...text].forEach((ch, i) => {
      if (sameLength && last.text[i] === ch) {
        el.append(ch);
        return;
      }
      const slot = document.createElement('span');
      slot.className = 't-subtle-slot';
      if (sameLength) {
        const old = document.createElement('span');
        old.className = 't-subtle-old';
        old.setAttribute('aria-hidden', 'true');
        old.textContent = last.text[i];
        slot.appendChild(old);
      }
      const fresh = document.createElement('span');
      fresh.className = 't-subtle-new';
      fresh.textContent = ch;
      slot.appendChild(fresh);
      el.appendChild(slot);
    });
    void el.offsetHeight; // force reflow so the animation replays
    el.classList.add('is-animating');
  }, [text, value]);

  return <span className={cn('t-subtle-number', className)} ref={ref} />;
}

/** Text swap soft (34): the old label blurs out while the new one blurs in, and the width eases. */
export function SoftText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement & { _softTimer?: number }>(null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!mounted.current) {
      mounted.current = true;
      el.dataset.text = text;
      el.textContent = text;
      return;
    }
    const prevText = el.dataset.text ?? el.textContent ?? '';
    if (prevText === text) return;
    el.dataset.text = text;
    window.clearTimeout(el._softTimer);

    const out = document.createElement('span');
    out.className = 't-text-soft-old';
    out.setAttribute('aria-hidden', 'true');
    out.textContent = prevText;
    const inn = document.createElement('span');
    inn.className = 't-text-soft-new';
    inn.textContent = text;

    const w0 = el.getBoundingClientRect().width;
    el.classList.remove('is-swapping');
    el.replaceChildren(out, inn);
    const w1 = inn.getBoundingClientRect().width;
    el.style.width = `${w0}px`;
    void el.offsetWidth; // force reflow so every transition runs
    el.classList.add('is-swapping');
    el.style.width = `${w1}px`;

    el._softTimer = window.setTimeout(
      () => {
        el.classList.remove('is-swapping');
        el.style.removeProperty('width');
        el.textContent = text;
      },
      Math.max(cssMs('--text-soft-dur', 200), cssMs('--text-soft-resize-dur', 240)) + 40,
    );
  }, [text]);

  return <span className={cn('t-text-soft', className)} ref={ref} />;
}

/** Shimmer text (15): pure CSS; the visible string is duplicated into data-text. */
export function Shimmer({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('t-shimmer', className)} data-text={text}>
      {text}
    </span>
  );
}

/** Texts reveal (18): lines rise in with a staggered blur once, on mount. */
export function TextsReveal({ lines, className }: { lines: ReactNode[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const block = ref.current;
    if (!block) return;
    const id = requestAnimationFrame(() => {
      block.classList.remove('is-hiding', 'is-shown');
      void block.offsetHeight;
      block.classList.add('is-shown');
    });
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className={cn('t-stagger', className)} ref={ref}>
      {lines.map((line, i) => (
        <div className={`t-stagger-line t-stagger-line--${i + 1}`} key={i}>
          {line}
        </div>
      ))}
    </div>
  );
}

/** Tabs sliding (16): a segmented control whose pill tweens to the selected tab. */
export function SlidingTabs<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const moveTo = (animate: boolean) => {
      const tab = bar.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      const p = pill.current;
      if (!tab || !p) return;
      if (!animate) {
        const prev = p.style.transition;
        p.style.transition = 'none';
        p.style.transform = `translateX(${tab.offsetLeft}px)`;
        p.style.width = `${tab.offsetWidth}px`;
        void p.offsetWidth;
        p.style.transition = prev;
      } else {
        p.style.transform = `translateX(${tab.offsetLeft}px)`;
        p.style.width = `${tab.offsetWidth}px`;
      }
    };
    moveTo(placed.current);
    placed.current = true;
    const onResize = () => moveTo(false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [value]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
    onChange(next.value);
    requestAnimationFrame(() => bar.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
  };

  return (
    <div aria-label={label} className={cn('t-tabs', className)} onKeyDown={onKeyDown} ref={bar} role="tablist">
      <span aria-hidden="true" className="t-tabs-pill" ref={pill} />
      {options.map((o) => (
        <button
          aria-selected={o.value === value}
          className="t-tab"
          key={o.value}
          onClick={() => onChange(o.value)}
          role="tab"
          tabIndex={o.value === value ? 0 : -1}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Toast open / close (22): toggles .is-open; the CSS owns the slower-in, faster-out timing. */
export type ToastItem = { id: number; title: string; body: string; tone: 'buy' | 'sell' | 'failed' };

function Toast({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    const hide = window.setTimeout(() => setOpen(false), 6000);
    const done = window.setTimeout(() => onDone(item.id), 6000 + cssMs('--toast-close', 250) + 50);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(hide);
      clearTimeout(done);
    };
  }, [item.id, onDone]);
  return (
    <div
      className={cn(
        't-toast pointer-events-auto w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover/95 px-4 py-3 text-sm shadow-lg backdrop-blur',
        open && 'is-open',
      )}
    >
      <p className="flex items-center gap-2 font-medium">
        <span
          aria-hidden="true"
          className={cn('size-2 rounded-full', item.tone === 'buy' ? 'bg-emerald-500' : item.tone === 'sell' ? 'bg-sky-500' : 'bg-rose-500')}
        />
        {item.title}
      </p>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.body}</p>
    </div>
  );
}

export function ToastStack({ items, onDone }: { items: ToastItem[]; onDone: (id: number) => void }) {
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col items-end gap-2" role="status">
      {items.map((t) => (
        <Toast item={t} key={t.id} onDone={onDone} />
      ))}
    </div>
  );
}
