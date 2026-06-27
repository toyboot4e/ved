// ArrowRight (line BACKWARD in vertical-rl) in the FIRST paragraph must not jump
// the caret to the paragraph start. `Selection.modify('line', backward)` at the
// first visual line slides to the line start (the paragraph's offset 0) — there
// is no line above — which read as "the caret leaps to the beginning". It should
// stay put instead.
//
// Usage: node test/e2e/line-move-first-para.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { caretToStart, clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

// VISIBLE window: moveCaretByLine defers via RAF (throttled when hidden).
const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

const off = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
// Press a line-move key and poll until it registers (or a generous cap).
const lineMove = async (key: string) => {
  const before = await off();
  await page.keyboard.press(key);
  for (let k = 0; k < 200; k++) {
    await page.waitForTimeout(16);
    if ((await off()) !== before) return;
  }
};

try {
  await page.click('#editor-content');
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(150);
  // A single first paragraph that wraps into ~3 reading columns.
  await page.keyboard.insertText('あ'.repeat(120));
  await page.waitForTimeout(300);
  await caretToStart(page);
  await page.waitForTimeout(120);

  // Advance forward two visual lines (into ~column 3), holding a mid-column depth.
  await lineMove('ArrowLeft');
  await lineMove('ArrowLeft');
  const mid = await off();
  assert.ok(mid > 0, `moved into the paragraph (offset ${mid})`);
  step(`caret at offset ${mid} after two ArrowLefts`);

  // ArrowRight (line backward) repeatedly: each step moves up at most one column
  // and, crucially, NEVER snaps to the paragraph start (offset 0) while a line
  // remains. After it reaches the first column it must STAY (no line above).
  const back: number[] = [mid];
  for (let i = 0; i < 5; i++) {
    await lineMove('ArrowRight');
    back.push(await off());
  }
  step(`offsets across 5 ArrowRights: ${back.join(' ')}`);

  // Each press moves up at MOST one column (~40 chars) and NEVER forward: the
  // old bug jumped straight to the paragraph start (a big backward leap) and, at
  // the very first line, leapt to the document END (a forward jump).
  for (let i = 1; i < back.length; i++) {
    const d = back[i - 1]! - back[i]!;
    assert.ok(d >= 0, `press ${i}: caret moved FORWARD (${back[i - 1]} → ${back[i]}); full: ${back.join(' ')}`);
    assert.ok(
      d <= 50,
      `press ${i}: caret LEAPT ${d} chars toward the start (${back[i - 1]} → ${back[i]}); full: ${back.join(' ')}`,
    );
  }
  step('ArrowRight in the first paragraph steps up one line at a time, never jumping');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-move-first-para e2e');
