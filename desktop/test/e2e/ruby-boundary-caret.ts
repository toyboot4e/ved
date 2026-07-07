// Regression: a caret at a TEXT-LESS ruby seam (between two collapsed rubies)
// must be VISIBLE, at the correct seam offset. The seam has no DOM text node
// (architecture.md "Caret at ruby boundaries"), so the native caret can't render there — pm/decorations.ts adds a
// rendered `.vedBoundaryCaret` widget at the head. The model offset is unchanged
// (the click is NOT snapped to a different position).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page, app } = ved;
const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const setCaret = (o: number) =>
  page.evaluate((n) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(n), o);
const hasBoundaryCaret = () => page.evaluate(() => !!document.querySelector('.vedBoundaryCaret'));
const caretLineWidth = () =>
  page.evaluate(() => {
    const c = document.querySelector('.vedBoundaryCaret');
    return c ? getComputedStyle(c, '::after').inlineSize : '';
  });
// Poll until `read` matches `want` (the suite runs many apps; fixed waits flake).
const until = async <T>(read: () => Promise<T>, want: T, label: string): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    if ((await read()) === want) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label}: still ${JSON.stringify(await read())} (want ${JSON.stringify(want)})`);
};
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText(t);
  await page.waitForTimeout(200);
};

try {
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich
  await page.keyboard.up('Control');
  await setDoc('あ|漢(かん)|字(じ)い'); // plain, ruby, ruby, plain — seam at offset 7

  // Click the seam between the two rubies.
  const pt = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#editor-content ruby')];
    const a = r[0]!.getBoundingClientRect();
    const b = r[1]!.getBoundingClientRect();
    return { x: Math.round((a.left + a.right) / 2), y: Math.round((a.bottom + b.top) / 2) };
  });
  await page.mouse.click(pt.x, pt.y);
  await until(caret, 7, 'click landed at the seam (offset 7), not snapped away');
  await until(hasBoundaryCaret, true, 'a boundary caret is rendered at the text-less seam');
  assert.equal(await caretLineWidth(), '1px', 'the boundary caret draws a 1px line');
  step('click between two rubies: caret at the seam (offset 7) and visible');

  // The caret is keyed to the HEAD, not clicks: it shows/hides as the caret moves.
  await setCaret(0);
  await until(hasBoundaryCaret, false, 'no boundary caret on plain text (offset 0)');
  await setCaret(7);
  await until(hasBoundaryCaret, true, 'boundary caret shows when navigated to the seam');
  step('boundary caret follows the caret to/from the seam');

  // REGRESSION (the too-large cursor at page-boundary lines): a caret at a
  // PARAGRAPH EDGE against hidden markup also has no text-node home. The
  // native caret there is ELEMENT-level, and at a multicol page break
  // Chromium painted it from cross-fragment union geometry — a bar spanning
  // the page gap. The fix: the widget renders at both paragraph edges too,
  // the caret's paragraph carries .vedNativeCaretOff (native caret
  // suppressed → it can never paint the bar), and the widget stays
  // glyph-sized. Native positions with a text home keep no widget/class.
  const stateAt = () =>
    page.evaluate(() => {
      const c = document.querySelector('.vedBoundaryCaret');
      const b = c?.getBoundingClientRect();
      const para = document.querySelector('#editor-content p') as Element;
      return {
        widget: !!c,
        suppressed: !!document.querySelector('#editor-content p.vedNativeCaretOff'),
        w: b ? b.width : -1,
        h: b ? b.height : -1,
        // The widget caret matches the native caret's extent: one line pitch.
        pitch: Number.parseFloat(getComputedStyle(para).lineHeight),
      };
    });
  // offsets: |0 漢1 (2 か3 ん4 )5 あ6 |7 字8 (9 じ10 )11 — length 12
  await setDoc('|漢(かん)あ|字(じ)');
  await setCaret(0); // paragraph start, before a leading (atom) ruby
  await until(hasBoundaryCaret, true, 'boundary caret at the paragraph start before a ruby');
  let s = await stateAt();
  assert.ok(s.suppressed, 'native caret suppressed while the widget renders (paragraph start)');
  assert.ok(s.w <= s.pitch * 1.2 && s.h <= s.pitch * 1.2, `widget glyph-sized at the start (${s.w}x${s.h})`);
  await setCaret(12); // paragraph end, after a trailing ruby
  await until(hasBoundaryCaret, true, 'boundary caret at the paragraph end after a ruby');
  s = await stateAt();
  assert.ok(s.suppressed, 'native caret suppressed while the widget renders (paragraph end)');
  assert.ok(s.w <= s.pitch * 1.2 && s.h <= s.pitch * 1.2, `widget glyph-sized at the end (${s.w}x${s.h})`);
  await setCaret(6); // before plain あ — a real text home: native caret, no widget
  await until(hasBoundaryCaret, false, 'no widget where the caret has a text home');
  s = await stateAt();
  assert.ok(!s.suppressed, 'native caret NOT suppressed at a text home');
  step('paragraph edges against hidden markup: widget caret + native caret suppressed');

  // The widget must have ZERO layout footprint: its bar is painted out of
  // flow, so the paragraph's geometry is IDENTICAL with the caret on and off
  // the widget spot (an in-flow extent grew the line per caret move — the
  // paragraph visibly shook as the caret travelled).
  const paraRect = () =>
    page.evaluate(() => {
      const r = document.querySelector('#editor-content p')!.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
  const away = await paraRect();
  await setCaret(0); // widget spot (paragraph start)
  await until(hasBoundaryCaret, true, 'widget on for the layout check');
  assert.deepEqual(await paraRect(), away, 'paragraph geometry unchanged when the widget caret appears');
  // And the painted bar spans the line pitch (the native caret extent).
  const barSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.querySelector('.vedBoundaryCaret')!, '::after').blockSize),
  );
  assert.ok(Math.abs(barSize - s.pitch) < 1, `bar spans the pitch (${barSize} vs ${s.pitch})`);
  step('widget caret has zero layout footprint; bar spans the pitch');

  // REGRESSION (invisible caret at lone-ruby doc edges): the appear-policy /
  // writing-mode effect rebuilt view.dom.className from scratch, WIPING PM's
  // ProseMirror-focused class. Real focus never left the editor, so PM never
  // re-added it (it only does on a real focus event) — and the widget caret,
  // whose blink is gated on that class, went invisible at every no-text-home
  // spot while typing kept working. The native caret (real-DOM-focus-driven)
  // was unaffected, which is why only these spots appeared caret-less.
  const focusedClass = () => page.evaluate(() => !!document.querySelector('.ProseMirror.ProseMirror-focused'));
  const blinkName = () =>
    page.evaluate(() => {
      const c = document.querySelector('.vedBoundaryCaret');
      return c ? getComputedStyle(c, '::after').animationName : '';
    });
  await setDoc('|ルビ(ruby)'); // a document of ONE ruby — both edges are widget spots
  await setCaret(0);
  await until(hasBoundaryCaret, true, 'widget at the lone-ruby doc start');
  assert.ok(await focusedClass(), 'editor is PM-focused before the mode switch');
  await clickWritingMode(page, 'Vertical');
  await until(focusedClass, true, 'ProseMirror-focused survives a writing-mode switch');
  await until(hasBoundaryCaret, true, 'widget still at the doc start after the switch');
  assert.equal(await blinkName(), 'vedCaretBlink', 'widget caret blinks after the mode switch');
  await setCaret(9); // doc end (after the ruby)
  await until(hasBoundaryCaret, true, 'widget at the lone-ruby doc end');
  assert.equal(await blinkName(), 'vedCaretBlink', 'widget caret blinks at the doc end');
  step('mode switch keeps ProseMirror-focused: the widget caret stays visible at lone-ruby edges');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await app.close();
}

finish('ruby-boundary-caret e2e');
