# Debugging a layout bug

vertical-rl + multicol is where "it looks wrong but I can't see why" bugs
live. The discipline that fixes them in one pass instead of ten:

- **Get a screenshot of the failing case before theorising.** It carries the
  three things measurements don't give at once: the writing mode, the kind of
  content that triggers it (a long *wrapping* line, a ruby, an over-length
  run — never a tidy sample), and the visual itself.
- **Don't trust `getBoundingClientRect` in fragmented layouts.** For a
  paragraph split across multicol columns it can report the capped extent
  while a line visibly overruns. Use rects to confirm a hypothesis, never to
  form one.
- **If the local environment can't reproduce it** (font, window size, device
  scale), say so and get the user's screenshot — a large window whose
  fallback CJK font renders fullwidth glyphs at ~1em "confirms" layouts the
  user's font breaks. `VED_SMOKE_SCALE` pins fractional HiDPI scales.
- **Capture harness**: a throwaway driver that launches the built app in a
  *visible* window (Playwright's `page.screenshot` stalls on the hidden
  smoke window; `webContents.capturePage().toDataURL()` does not), types the
  scenario matched to the report, switches to the exact mode named in the
  bug, and writes PNGs. Shrink a tall capture to read it inline
  (`magick cap.png -resize 900x cap-small.png`). The driver stays a temp
  file — the durable artifact is an e2e regression test in `test/e2e/`.
