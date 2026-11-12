/**
 * The timeline's styles, injected once per document. Every colour and font is a custom property
 * with the smalt (Kiln) value as its fallback, so a page can restyle it: set `--cy-tl-bg`,
 * `--cy-tl-track`, `--cy-tl-text`, `--cy-tl-text-2`, `--cy-tl-primary`, `--cy-tl-on-primary`,
 * `--cy-tl-accent`, `--cy-tl-focus`, `--cy-tl-font-mono` or `--cy-tl-font-brand` on the host or above.
 */

const LIGHT = `
  --_bg: var(--cy-tl-bg, #FFFFFF);
  --_track: var(--cy-tl-track, #D6DBE4);
  --_text: var(--cy-tl-text, #151922);
  --_text2: var(--cy-tl-text-2, #3F4656);
  --_primary: var(--cy-tl-primary, #003399);
  --_on-primary: var(--cy-tl-on-primary, #FFFFFF);
  --_accent: var(--cy-tl-accent, #E5622F);
  --_focus: var(--cy-tl-focus, #003399);
  --_hover: rgba(21, 25, 34, 0.06);`;

const DARK = `
  --_bg: var(--cy-tl-bg, #1B1F29);
  --_track: var(--cy-tl-track, #2C3240);
  --_text: var(--cy-tl-text, #E9EBF0);
  --_text2: var(--cy-tl-text-2, #B9BEC9);
  --_primary: var(--cy-tl-primary, #9DB4F5);
  --_on-primary: var(--cy-tl-on-primary, #14171F);
  --_accent: var(--cy-tl-accent, #FF8A5C);
  --_focus: var(--cy-tl-focus, #FF8A5C);
  --_hover: rgba(233, 235, 240, 0.08);`;

export const TIMELINE_CSS = `
.cy-tl {${LIGHT}
  --_mono: var(--cy-tl-font-mono, 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace);
  --_brand: var(--cy-tl-font-brand, 'Martian Mono', 'Geist Mono', ui-monospace, monospace);
  box-sizing: border-box;
  min-width: 0;
  padding: 10px 16px 12px;
  background: var(--_bg);
  color: var(--_text);
  font: 13px/1.4 var(--_mono);
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.cy-tl[data-theme="dark"] {${DARK}
}
@media (prefers-color-scheme: dark) {
  .cy-tl:not([data-theme]) {${DARK}
  }
}
.cy-tl *, .cy-tl *::before, .cy-tl *::after { box-sizing: border-box; }
.cy-tl-ruler {
  position: relative;
  height: 72px;
  touch-action: none;
  cursor: pointer;
}
.cy-tl-ruler.cy-tl-panning { cursor: grabbing; }
.cy-tl-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.cy-tl-handle {
  position: absolute;
  top: 44px;
  left: 0;
  width: 18px;
  height: 18px;
  margin: -9px 0 0 -9px;
  border-radius: 50%;
  background: var(--_primary);
  border: 3px solid var(--_bg);
  box-shadow: 0 0 0 1px var(--_primary);
  cursor: grab;
  outline: none;
  will-change: transform;
}
.cy-tl-handle:focus-visible {
  outline: 2px solid var(--_focus);
  outline-offset: 2px;
}
.cy-tl-dragging .cy-tl-handle { cursor: grabbing; }
.cy-tl-tip {
  position: absolute;
  z-index: 2;
  left: 0;
  max-width: min(320px, 100%);
  padding: 8px 10px;
  border: 1px solid var(--_track);
  border-radius: 6px;
  background: var(--_bg);
  color: var(--_text);
  box-shadow: 0 4px 16px rgba(10, 14, 24, 0.14);
  font: 12px/1.45 var(--_mono);
  pointer-events: none;
  white-space: nowrap;
}
.cy-tl-tip[hidden] { display: none; }
.cy-tl-tip-msg {
  overflow: hidden;
  text-overflow: ellipsis;
}
.cy-tl-tip-meta { color: var(--_text2); }
.cy-tl-eyebrow {
  font: 600 10px/1 var(--_brand);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--_text2);
}
.cy-tl-tip .cy-tl-eyebrow { display: block; margin-bottom: 4px; }
.cy-tl-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 6px;
}
.cy-tl-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.cy-tl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  min-width: 32px;
  padding: 0 8px;
  border: 1px solid var(--_track);
  border-radius: 6px;
  background: transparent;
  color: var(--_text);
  font: 500 12px/1 var(--_mono);
  cursor: pointer;
}
.cy-tl-btn:hover { background: var(--_hover); }
.cy-tl-btn:focus-visible {
  outline: 2px solid var(--_focus);
  outline-offset: 2px;
}
.cy-tl-btn:disabled { opacity: 0.45; cursor: default; background: transparent; }
.cy-tl-btn svg { width: 16px; height: 16px; fill: currentColor; flex: none; }
.cy-tl-play {
  background: var(--_primary);
  border-color: var(--_primary);
  color: var(--_on-primary);
  min-width: 40px;
}
.cy-tl-play:hover { background: var(--_primary); filter: brightness(1.12); }
.cy-tl-seg {
  display: inline-flex;
  border: 1px solid var(--_track);
  border-radius: 6px;
  overflow: hidden;
  flex: none;
}
.cy-tl-seg .cy-tl-btn {
  border: 0;
  border-radius: 0;
  height: 30px;
}
.cy-tl-seg .cy-tl-btn + .cy-tl-btn { border-left: 1px solid var(--_track); }
.cy-tl-seg .cy-tl-btn[aria-pressed="true"] {
  background: var(--_track);
  font-weight: 700;
}
.cy-tl-seg .cy-tl-btn:focus-visible { outline-offset: -2px; }
.cy-tl-readout {
  flex: 1 1 220px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--_text2);
}
.cy-tl-readout b { color: var(--_text); font-weight: 600; }
.cy-tl-sep { opacity: 0.6; }
.cy-tl-fit[hidden] { display: none; }
@media (pointer: coarse) {
  .cy-tl-btn { height: 40px; min-width: 40px; }
  .cy-tl-seg .cy-tl-btn { height: 38px; }
  .cy-tl-handle { width: 24px; height: 24px; margin: -12px 0 0 -12px; }
}
@media (prefers-reduced-motion: reduce) {
  .cy-tl-handle { will-change: auto; }
}
`;

const STYLE_ID = 'cy-tl-style';

/** Add the styles to the document once. */
export function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TIMELINE_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}
