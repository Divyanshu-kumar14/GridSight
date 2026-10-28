# GridSight DESIGN.md — "Switchyard at night" (v2, hardware board)

World: the yard after dark, read from a control room. Ink-black ground, amber signal
color, single-line-diagram hairlines with node dots, equipment-nameplate spec rows.
Dark is forced by the scene (reviewing footage in a dark room), never by category.
v2 evolves to dense-tiles board: filled 72px bands, 4px gaps, no dividers, steel for secondary text.

## Tokens
- Ground `ink #05070C` · panel `#0B111D` · hairline `rgba(148,163,184,.16)` (token `line`)
- Hardware: porcelain `#E8E4DA` (accent) · steel `#9AA3B2` (secondary) · bus `#334155` (spine)
- Accent amber-500 `#f59e0b` (hover amber-400); text on amber is always slate-950
- Severity jobs only: red-500 CRITICAL · orange-500 HIGH · yellow-500 MEDIUM · green-600/400 LOW/ok
- Body text slate-100/porcelain · secondary steel/slate-400 · faint slate-500/600

## Type
- Display/body: Geist (local `GeistVF`), tight tracking, balanced headlines
- Data only: GeistMono (`GeistMonoVF`) — timestamps, ids, model names, numerals (tabular)
- Micro-labels: 11px semibold uppercase 0.14em tracking, sans (never mono)

## Components
- `.panel`: rounded-md, 1px hairline border, panel bg
- `.btn-primary` amber/slate-950 · `.btn-ghost` hairline border, transparent ground
- Pipeline nodes: numbered amber-ring dots on a hairline (sequence earns numbers)
- Nameplate rows: mono id · micro-label role · secondary description (divide-y sheet)
- Severity badge: mono bold on severity color, slate-950 text
- No kickers above headings · no gradient text · no metric cards · no glass/blur ·
  no colored left borders >1px · no hard offset shadows · no emoji icons (lucide only)

## Motion (one language)
- `gs-rise`: 16px → 0, exponential ease-out `cubic-bezier(.16,1,.3,1)`, from visible defaults
- Hero viewport: `gs-scan` sweep 5.5s + drifting boxes + blinking REC + ticking clock
- `prefers-reduced-motion` collapses all animation; rAF canvas loop runs only while playing
- Canvas overlays capped at 128 boxes/frame with console warn

## Browser surfaces
- Selection amber-on-ink · thin dark scrollbars · amber focus-visible rings

## States
- Every surface: loading (route + button spinners), error (alert + retry), empty (hint, never blank),
  404 + global error boundary with recovery action
