// REAL mozc Space conversion (henkan) while composing as an ISOLATED text node
// — the preedit right after a ruby at a paragraph end (nothing to merge with).
//
// The conversion REPLACES the preedit with a shorter candidate (かんじ → 感じ),
// which invalidates the DOM caret offset; Blink transiently clears the DOM
// selection, so PM's findCompositionNode reads a null selection at flush time,
// loses the composition node, and redraws it — fcitx5 then silently commits the
// preedit: Space "completes" the composition instead of converting, and no
// compositionend ever fires (the view is stuck composing, which also disables
// structure repair). The editor's domSelectionRange fallback (editor.tsx)
// answers a null selection with the IME's last-changed text node, keeping the
// composition protected. Merged preedits (plain text around) never hit this.
//
// Assertions are mozc-learning-independent: candidates vary, so the checks are
// "Escape after converting restores the base text exactly" (a committed
// candidate would survive Escape) and "a second Space cycles candidates rather
// than inserting a space".
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while
// it runs — don't type. Run: node test/e2e/mozc/space-convert.ts
import assert from 'node:assert/strict';
import { fail, finish, setCaret, setDoc, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('space-convert (skipped)');
  process.exit(0);
}

const BASE = '|ルビ(ruby)'; // caret at 9 = doc end: the preedit is an isolated text node

const m = await openMozc();
const { page } = m;

try {
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich
  await page.keyboard.up('Control');
  await page.waitForTimeout(150);

  // Warm-up composition (cold mozc drops the first one).
  await m.type('a');
  await m.commit();

  // Case 1: convert, then Escape twice (conversion → preedit → dropped). A
  // live composition unwinds to the base text; a force-committed candidate
  // would remain in the document.
  await setDoc(page, BASE, 300);
  await setCaret(page, BASE.length, 150);
  await m.escape();
  const live = await m.type('kanji');
  assert.equal(live, `${BASE}かんじ`, 'composes as the preedit after the ruby');
  const converted = await m.convert();
  assert.notEqual(converted, `${BASE}かんじ`, 'Space converts the preedit (text changes)');
  await m.escape();
  await m.escape();
  const unwound = await page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
  assert.equal(unwound, BASE, `Escape unwinds the conversion — still composing, nothing committed`);
  step('space converts the isolated preedit after a ruby; Escape unwinds it (still composing)');

  // Case 2: a second Space cycles candidates (a dead composition would insert
  // a space instead); Enter then commits a space-free candidate.
  await setDoc(page, BASE, 300);
  await setCaret(page, BASE.length, 150);
  await m.escape();
  await m.type('kanji');
  await m.convert();
  const cycled = await m.convert();
  assert.ok(
    !cycled.includes('　') && !cycled.includes(' '),
    `second Space cycles candidates, no space: ${JSON.stringify(cycled)}`,
  );
  const committed = await m.commit();
  assert.ok(
    !committed.includes('　') &&
      !committed.includes(' ') &&
      committed.startsWith(BASE) &&
      committed.length > BASE.length,
    `commit lands the candidate, no stray space: ${JSON.stringify(committed)}`,
  );
  step('second space cycles candidates; Enter commits — the composition survived the conversion');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('space-convert e2e (real mozc)');
