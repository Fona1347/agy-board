import { getMcpAppCardJs } from './card-bundle.ts'

const CARD_CSS = `
  :root {
    color-scheme: dark;
    --agy-bg: var(--color-background-primary, #1C1C1A);
    --agy-card: var(--color-background-secondary, #282825);
    --agy-card-elev: var(--color-background-tertiary, #31312D);
    --agy-fg: var(--color-text-primary, #ddd9d0);
    --agy-fg-strong: var(--color-text-primary, #f2efe9);
    --agy-muted-fg: var(--color-text-secondary, #aba69d);
    --agy-border: var(--color-border-primary, rgba(255, 255, 255, 0.11));
    --agy-border-strong: var(--color-border-secondary, rgba(255, 255, 255, 0.20));
    --agy-primary: #D4894A;
    --agy-primary-fg: #1e1913;
    --agy-primary-text: #E2A269;
    --agy-ok: #22c55e;
    --agy-ok-fg: var(--color-text-success, #4ade80);
    --agy-ok-bg: var(--color-background-success, rgba(34, 197, 94, 0.14));
    --agy-ok-border: var(--color-border-success, rgba(74, 222, 128, 0.38));
    --agy-active-fg: var(--color-text-info, #7cb3f4);
    --agy-active-bg: var(--color-background-info, rgba(59, 130, 246, 0.15));
    --agy-active-border: var(--color-border-info, rgba(96, 165, 250, 0.42));
    --agy-warn-fg: var(--color-text-warning, #FBBF24);
    --agy-warn-bg: var(--color-background-warning, rgba(245, 158, 11, 0.14));
    --agy-warn-border: var(--color-border-warning, rgba(245, 158, 11, 0.40));
    --agy-danger-fg: var(--color-text-danger, #f87171);
    --agy-danger-bg: var(--color-background-danger, rgba(239, 68, 68, 0.15));
    --agy-danger-border: var(--color-border-danger, rgba(248, 113, 113, 0.40));
    --agy-recessed: rgba(0, 0, 0, 0.22);
    --font: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --agy-bg: var(--color-background-primary, #F7F6F3);
    --agy-card: var(--color-background-secondary, #FFFFFF);
    --agy-card-elev: var(--color-background-tertiary, #F1EFEA);
    --agy-fg: var(--color-text-primary, #22201d);
    --agy-fg-strong: var(--color-text-primary, #141210);
    --agy-muted-fg: var(--color-text-secondary, #5f5a52);
    --agy-border: var(--color-border-primary, rgba(28, 25, 23, 0.11));
    --agy-border-strong: var(--color-border-secondary, rgba(28, 25, 23, 0.20));
    --agy-primary: #B45309;
    --agy-primary-fg: #FFFFFF;
    --agy-primary-text: #9A4A0B;
    --agy-ok: #16a34a;
    --agy-ok-fg: var(--color-text-success, #15803d);
    --agy-ok-bg: var(--color-background-success, rgba(22, 163, 74, 0.10));
    --agy-ok-border: var(--color-border-success, rgba(21, 128, 61, 0.34));
    --agy-active-fg: var(--color-text-info, #1d4ed8);
    --agy-active-bg: var(--color-background-info, rgba(37, 99, 235, 0.10));
    --agy-active-border: var(--color-border-info, rgba(37, 99, 235, 0.34));
    --agy-warn-fg: var(--color-text-warning, #B45309);
    --agy-warn-bg: var(--color-background-warning, rgba(217, 119, 6, 0.11));
    --agy-warn-border: var(--color-border-warning, rgba(217, 119, 6, 0.34));
    --agy-danger-fg: var(--color-text-danger, #b91c1c);
    --agy-danger-bg: var(--color-background-danger, rgba(220, 38, 38, 0.10));
    --agy-danger-border: var(--color-border-danger, rgba(220, 38, 38, 0.34));
    --agy-recessed: rgba(28, 25, 23, 0.04);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 8px;
    background: transparent;
    color: var(--agy-fg);
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.45;
  }
  button, input, select, textarea { font: inherit; color: inherit; }
  .tabular-nums { font-variant-numeric: tabular-nums; }
  .pre-wrap { white-space: pre-wrap; word-break: break-word; }

  .agy-card {
    background: var(--agy-card);
    border: 1px solid var(--agy-border);
    border-radius: 10px;
    padding: 12px 14px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);
  }
  .agy-card.tint-warn { border-color: var(--agy-warn-border); }
  .agy-card.tint-active { border-color: var(--agy-active-border); }
  .agy-card.tint-ok { border-color: var(--agy-ok-border); }
  .agy-card.tint-danger { border-color: var(--agy-danger-border); }

  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .between { justify-content: space-between; }
  .nav-strip { margin-bottom: 6px; }
  .header-row { gap: 8px; align-items: flex-start; }
  .title-group { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 180px; }
  .card-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--agy-fg-strong); word-break: break-word; }
  .pills-group { flex-shrink: 0; }

  .status-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 2px solid var(--agy-muted-fg);
  }
  .status-dot.status-active { border-color: var(--agy-active-fg); background: var(--agy-active-fg); }
  .status-dot.status-needs_you { border-color: var(--agy-ok-fg); background: var(--agy-ok-fg); }
  .status-dot.status-closed { border-color: var(--agy-ok-fg); background: var(--agy-ok-fg); }
  .status-dot.status-on_hold { border-color: var(--agy-danger-fg); background: var(--agy-danger-fg); }
  .status-dot.status-draft { border-color: var(--agy-warn-fg); background: transparent; border-style: dashed; }

  .pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid var(--agy-border);
    background: var(--agy-recessed);
    color: var(--agy-fg);
  }
  .pill-xs { font-size: 10px; padding: 1px 6px; }
  .pill-warn { border-color: var(--agy-warn-border); background: var(--agy-warn-bg); color: var(--agy-warn-fg); }
  .pill-active { border-color: var(--agy-active-border); background: var(--agy-active-bg); color: var(--agy-active-fg); }
  .pill-ok { border-color: var(--agy-ok-border); background: var(--agy-ok-bg); color: var(--agy-ok-fg); }
  .pill-danger { border-color: var(--agy-danger-border); background: var(--agy-danger-bg); color: var(--agy-danger-fg); }

  .prio-select {
    appearance: auto;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 999px;
    border: 1px solid var(--agy-border);
    background: var(--agy-recessed);
    cursor: pointer;
  }
  .prio-select.prio-urgent { border-color: var(--agy-danger-border); color: var(--agy-danger-fg); }
  .prio-select.prio-high { border-color: var(--agy-warn-border); color: var(--agy-warn-fg); }

  .meta-row { margin-top: 6px; gap: 5px; }
  .ws-chip {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 500;
    background: var(--agy-card-elev);
    border: 1px solid var(--agy-border);
    color: var(--agy-fg);
  }
  .meta-chip { font-size: 11px; color: var(--agy-muted-fg); }
  .tag-chip {
    font-size: 11px;
    color: var(--agy-primary-text);
    background: rgba(212, 137, 74, 0.12);
    border-radius: 4px;
    padding: 1px 5px;
  }

  .gate-banner {
    margin-top: 9px;
    padding: 8px 10px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .gate-warn { border: 1px solid var(--agy-warn-border); background: var(--agy-warn-bg); }
  .gate-danger { border: 1px solid var(--agy-danger-border); background: var(--agy-danger-bg); }
  .gate-text { flex: 1; min-width: 180px; }
  .gate-title { font-size: 12px; font-weight: 600; color: var(--agy-warn-fg); }
  .gate-danger .gate-title { color: var(--agy-danger-fg); }
  .gate-body { font-size: 11.5px; color: var(--agy-fg); margin-top: 2px; }

  .human-notes-box {
    margin-top: 9px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--agy-warn-border);
    background: rgba(212, 137, 74, 0.10);
  }
  .human-notes-title { font-size: 11.5px; font-weight: 600; color: var(--agy-primary-text); }
  .notes-body { margin-top: 4px; font-size: 12.5px; color: var(--agy-fg-strong); }

  .brief-text { margin-top: 8px; font-size: 12.5px; color: var(--agy-fg); }
  .inline-callout {
    margin-top: 6px;
    padding: 5px 8px;
    border-radius: 6px;
    background: var(--agy-recessed);
    font-size: 12px;
  }
  .callout-warn { border-left: 2px solid var(--agy-warn-fg); }
  .callout-label { font-weight: 600; color: var(--agy-muted-fg); }

  .section { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--agy-border); }
  .sec-title { font-size: 11.5px; font-weight: 600; color: var(--agy-muted-fg); text-transform: none; }
  .muted-xs { font-size: 11.5px; color: var(--agy-muted-fg); }

  .bar-wrap { height: 5px; border-radius: 999px; background: var(--agy-recessed); overflow: hidden; margin-top: 6px; }
  .bar-fill { height: 100%; background: var(--agy-ok); transition: width 0.2s ease; }

  .sg-list { margin-top: 7px; display: flex; flex-direction: column; gap: 4px; }
  .sg-row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 3px 4px;
    border-radius: 6px;
  }
  .sg-row:hover { background: var(--agy-recessed); }
  .sg-row.is-done .sg-title { text-decoration: line-through; color: var(--agy-muted-fg); }
  .sg-check { cursor: pointer; accent-color: var(--agy-primary); flex-shrink: 0; }
  .sg-title { flex: 1; font-size: 12.5px; word-break: break-word; }
  .sg-req-badge {
    font-size: 10.5px;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--agy-border);
    background: transparent;
    color: var(--agy-muted-fg);
    cursor: pointer;
  }
  .sg-req-badge.is-required { color: var(--agy-fg); border-color: var(--agy-border-strong); font-weight: 600; }

  .sg-add-row { display: flex; gap: 6px; margin-top: 7px; }
  .edit-form { margin-top: 9px; padding: 9px; border-radius: 8px; background: var(--agy-recessed); display: flex; flex-direction: column; gap: 8px; }
  .field-label { display: flex; flex-direction: column; gap: 3px; }
  .field-caption { font-size: 11px; font-weight: 600; color: var(--agy-muted-fg); }
  .field-input, .field-textarea {
    width: 100%;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid var(--agy-border-strong);
    background: var(--agy-card);
    color: var(--agy-fg-strong);
    font-size: 12.5px;
  }
  .field-input-sm { padding: 4px 8px; font-size: 12px; }
  .field-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
  .edit-actions { justify-content: flex-end; }

  .details-panel { display: flex; flex-direction: column; gap: 8px; }
  .detail-block { display: flex; flex-direction: column; gap: 3px; }
  .contract-pre {
    padding: 7px 9px;
    border-radius: 6px;
    background: var(--agy-recessed);
    font-size: 12px;
    max-height: 220px;
    overflow-y: auto;
  }
  .ref-list { margin: 2px 0 0; padding-left: 16px; }
  .ref-item { font-size: 11.5px; color: var(--agy-fg); margin: 2px 0; word-break: break-all; }

  .action-footer { gap: 8px; }
  .action-btns { gap: 6px; }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border-radius: 7px;
    border: 1px solid var(--agy-border-strong);
    background: var(--agy-card-elev);
    color: var(--agy-fg-strong);
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s ease, background 0.15s ease;
  }
  .btn:hover:not(:disabled) { opacity: 0.9; }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .btn-xs { padding: 2px 7px; font-size: 11px; }
  .btn-ghost { background: transparent; border-color: var(--agy-border); color: var(--agy-muted-fg); }
  .btn-ghost:hover:not(:disabled) { color: var(--agy-fg-strong); background: var(--agy-recessed); }
  .btn-primary { background: var(--agy-primary); border-color: var(--agy-primary); color: var(--agy-primary-fg); font-weight: 600; }
  .btn-warn { background: var(--agy-warn-fg); border-color: var(--agy-warn-fg); color: #1b160c; font-weight: 600; }
  .btn-accent-outline { border-color: var(--agy-primary); color: var(--agy-primary-text); background: transparent; }

  .feedback-bar {
    margin-top: 8px;
    padding: 6px 9px;
    border-radius: 6px;
    font-size: 12px;
  }
  .feedback-ok { background: var(--agy-ok-bg); border: 1px solid var(--agy-ok-border); color: var(--agy-ok-fg); }
  .feedback-info { background: var(--agy-active-bg); border: 1px solid var(--agy-active-border); color: var(--agy-active-fg); }
  .feedback-error { background: var(--agy-danger-bg); border: 1px solid var(--agy-danger-border); color: var(--agy-danger-fg); }

  .list-wrap { display: flex; flex-direction: column; gap: 2px; }
  .list-row { padding: 7px 6px; border-radius: 7px; border-bottom: 1px solid var(--agy-border); }
  .list-row:last-child { border-bottom: 0; }
  .list-row.is-clickable:hover { background: var(--agy-recessed); }
  .list-title-btn {
    border: 0;
    background: transparent;
    padding: 0;
    text-align: left;
    font-weight: 600;
    font-size: 13px;
    color: var(--agy-fg-strong);
    cursor: pointer;
    word-break: break-word;
  }
  .list-title-btn:hover:not(:disabled) { text-decoration: underline; }
  .list-sub { margin-top: 3px; padding-left: 16px; }
`

export function renderMcpAppCardHtml(): string {
  const safeJs = getMcpAppCardJs()
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Agy Board Task Card</title>
<style>${CARD_CSS}</style>
</head>
<body>
  <div id="app"><div class="agy-card"><div class="muted-xs">Loading Agy Board card...</div></div></div>
  <script>${safeJs}</script>
</body>
</html>`
}
