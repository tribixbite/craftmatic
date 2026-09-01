/**
 * Fixed overlay export-progress banner (S2).
 *
 * The LEGO tab's `#lego-status` line is the LOG — it lives inside the
 * scrollable control panel and is invisible once the user scrolls, so a long
 * export (voxelize → NBT → gzip; seconds to minutes on a big set) looked like a
 * hang. This is a `position: fixed` bar pinned to the top of the viewport,
 * above everything, showing the live phase ("voxelizing 34%", "writing NBT",
 * "compressing") with a determinate bar when a percentage is known and an
 * indeterminate sweep when it isn't.
 *
 * Contract:
 *   const p = beginExportProgress('Exporting 21063.schem');
 *   p.update('voxelizing', 34);   // pct optional → indeterminate
 *   p.done('Exported …');         // green flash, auto-dismiss
 *   p.fail('…');                  // red, sticky, dismiss ×
 *
 * Gotcha honoured (CLAUDE.md): visibility is driven by `style.display`, never
 * the `hidden` attribute — a `display:` rule in CSS overrides `[hidden]`.
 */

const STYLE_ID = 'export-progress-style';
const BAR_ID = 'export-progress-bar';

const CSS = `
#${BAR_ID} {
  position: fixed;
  /* Sits directly BELOW the app nav so it never covers the tab bar. The exact
     offset is re-measured from #nav at show time (mobile shrinks the nav). */
  top: var(--nav-h, 0px); left: 0; right: 0;
  z-index: 10000;
  display: none;
  box-sizing: border-box;
  padding: 8px 12px;
  background: rgba(16, 18, 26, 0.96);
  color: #e8e8ef;
  font: 500 0.78rem/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
  border-bottom: 1px solid rgba(255,255,255,0.14);
  box-shadow: 0 2px 14px rgba(0,0,0,0.45);
  backdrop-filter: blur(6px);
}
#${BAR_ID}.is-ok    { background: rgba(20, 48, 28, 0.97); border-bottom-color: #2f7d4a; }
#${BAR_ID}.is-error { background: rgba(56, 20, 22, 0.97); border-bottom-color: #a8433f; }
#${BAR_ID} .ep-row { display: flex; align-items: center; gap: 10px; }
#${BAR_ID} .ep-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
#${BAR_ID} .ep-phase { flex: 1 1 auto; opacity: 0.88; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${BAR_ID} .ep-pct { font-variant-numeric: tabular-nums; opacity: 0.9; }
#${BAR_ID} .ep-close {
  flex: 0 0 auto; display: none; cursor: pointer; border: 0; border-radius: 4px;
  background: rgba(255,255,255,0.1); color: inherit; font-size: 0.85rem;
  line-height: 1; padding: 4px 8px;
}
#${BAR_ID}.is-error .ep-close { display: block; }
#${BAR_ID} .ep-track {
  position: relative; margin-top: 6px; height: 4px; border-radius: 2px;
  background: rgba(255,255,255,0.13); overflow: hidden;
}
#${BAR_ID} .ep-fill {
  position: absolute; inset: 0 auto 0 0; width: 0%;
  background: linear-gradient(90deg, #4a9eff, #7ad3ff);
  transition: width 120ms linear;
}
#${BAR_ID}.is-ok .ep-fill { background: #4fbf72; }
#${BAR_ID}.is-error .ep-fill { background: #d9534f; width: 100% !important; }
#${BAR_ID}.is-indeterminate .ep-fill {
  width: 32% !important; transition: none;
  animation: ep-sweep 1.1s ease-in-out infinite;
}
@keyframes ep-sweep {
  0%   { transform: translateX(-110%); }
  100% { transform: translateX(330%); }
}
@media (max-width: 640px) {
  #${BAR_ID} { font-size: 0.72rem; padding-left: 10px; padding-right: 10px; }
  #${BAR_ID} .ep-title { max-width: 38%; }
}
@media (prefers-reduced-motion: reduce) {
  #${BAR_ID}.is-indeterminate .ep-fill { animation: none; width: 100% !important; opacity: 0.5; }
}
`;

interface Els {
  root: HTMLElement;
  title: HTMLElement;
  phase: HTMLElement;
  pct: HTMLElement;
  fill: HTMLElement;
  close: HTMLButtonElement;
}

let els: Els | null = null;
/** Monotonic token so a stale handle can't overwrite a newer export's banner. */
let activeToken = 0;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function ensureEls(): Els | null {
  if (typeof document === 'undefined') return null;
  if (els && els.root.isConnected) return els;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const root = document.createElement('div');
  root.id = BAR_ID;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.innerHTML =
    '<div class="ep-row">' +
      '<span class="ep-title"></span>' +
      '<span class="ep-phase"></span>' +
      '<span class="ep-pct"></span>' +
      '<button type="button" class="ep-close" aria-label="Dismiss">✕</button>' +
    '</div>' +
    '<div class="ep-track"><div class="ep-fill"></div></div>';
  document.body.appendChild(root);

  els = {
    root,
    title: root.querySelector('.ep-title') as HTMLElement,
    phase: root.querySelector('.ep-phase') as HTMLElement,
    pct: root.querySelector('.ep-pct') as HTMLElement,
    fill: root.querySelector('.ep-fill') as HTMLElement,
    close: root.querySelector('.ep-close') as HTMLButtonElement,
  };
  els.close.addEventListener('click', () => hide());
  return els;
}

function hide(): void {
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
  if (els) els.root.style.display = 'none';
}

export interface ExportProgressHandle {
  /** Set the current phase; omit `pct` for an indeterminate bar. */
  update(phase: string, pct?: number): void;
  /** Success: brief green flash, then auto-dismiss. */
  done(message?: string): void;
  /** Failure: red, sticky until the user dismisses it. */
  fail(message: string): void;
}

/** No-op handle for non-DOM contexts (tests, workers). */
const NOOP: ExportProgressHandle = { update() {}, done() {}, fail() {} };

/**
 * Show the export banner and return a handle for the caller's export.
 * Starting a new export supersedes any earlier handle.
 */
export function beginExportProgress(title: string): ExportProgressHandle {
  const e = ensureEls();
  if (!e) return NOOP;

  const token = ++activeToken;
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }

  // Re-measure the nav each time — its height differs between the desktop and
  // mobile layouts, and it must never be covered.
  const nav = document.getElementById('nav');
  const navBottom = nav ? Math.max(0, Math.round(nav.getBoundingClientRect().bottom)) : 0;
  e.root.style.top = `${navBottom}px`;

  e.root.className = 'is-indeterminate';
  // style.display, not [hidden] — a `display:` rule would override the attribute.
  e.root.style.display = 'block';
  e.title.textContent = title;
  e.phase.textContent = 'starting…';
  e.pct.textContent = '';
  e.fill.style.width = '0%';

  const current = () => token === activeToken && els === e;

  return {
    update(phase: string, pct?: number) {
      if (!current()) return;
      e.phase.textContent = phase;
      if (pct == null || !Number.isFinite(pct)) {
        e.root.classList.add('is-indeterminate');
        e.pct.textContent = '';
      } else {
        const clamped = Math.max(0, Math.min(100, Math.round(pct)));
        e.root.classList.remove('is-indeterminate');
        e.fill.style.width = `${clamped}%`;
        e.pct.textContent = `${clamped}%`;
      }
    },
    done(message?: string) {
      if (!current()) return;
      e.root.className = 'is-ok';
      e.phase.textContent = message ?? 'done';
      e.pct.textContent = '';
      e.fill.style.width = '100%';
      dismissTimer = setTimeout(() => { if (current()) hide(); }, 2600);
    },
    fail(message: string) {
      if (!current()) return;
      e.root.className = 'is-error';
      e.phase.textContent = message;
      e.pct.textContent = '';
    },
  };
}
