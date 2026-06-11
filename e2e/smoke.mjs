// End-to-end smoke test against the built app (run `pnpm run build` first).
// Usage: pnpm run smoke   (or: node e2e/smoke.mjs)
import assert from 'node:assert/strict';
import { _electron } from 'playwright';

const root = new URL('..', import.meta.url).pathname;
const app = await _electron.launch({
  executablePath: `${root}node_modules/electron/dist/electron`,
  args: [`${root}out/main/index.js`],
});
const page = await app.firstWindow();
await page.waitForSelector('#editor-content');

const snap = () =>
  page.evaluate(() => {
    const el = document.getElementById('editor-content');
    return {
      // ﻿ anchors come from slate-react's empty-leaf rendering
      text: (el.textContent ?? '').replaceAll('﻿', ''),
      rubies: el.querySelectorAll('[class*=rubyWrap],[class*=rubyExpanded]').length,
      collapsed: el.querySelectorAll('[class*=rubyWrap]').length,
    };
  });

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const step = (msg) => console.log(`✓ ${msg}`);

try {
  // Initial document renders with one collapsed ruby
  let s = await snap();
  assert.equal(s.text, '|ルビ(ruby)');
  assert.equal(s.collapsed, 1);
  step('initial render');

  // Type ruby syntax at the paragraph start → a second ruby element appears.
  // The caret is placed programmatically: visual Home/End can land inside
  // the annotation box (known caret papercut, see docs/architecture.md).
  await page.click('#editor-content');
  await page.keyboard.press('Control+g'); // Rich
  const caretToStart = () =>
    page.evaluate(() => {
      const el = document.getElementById('editor-content');
      const first = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      getSelection().collapse(first, 0);
    });
  await caretToStart();
  await page.keyboard.type('|試(し)あ');
  s = await snap();
  assert.equal(s.text, '|試(し)あ|ルビ(ruby)');
  assert.equal(s.rubies, 2);
  step('typed syntax converts to a ruby element');

  // ShowAll: same text, all rubies expanded
  await page.keyboard.press('Control+s');
  s = await snap();
  assert.equal(s.text, '|試(し)あ|ルビ(ruby)');
  assert.equal(s.collapsed, 0);
  step('ShowAll expands without changing text');

  // Rich again: collapsed
  await page.keyboard.press('Control+g');
  s = await snap();
  assert.equal(s.collapsed, 2);
  step('Rich collapses again');

  // Vertical arrow navigation (default mode is vertical columns):
  // ArrowDown moves the caret forward by one character
  const sel = () =>
    page.evaluate(() => {
      const s = getSelection();
      return { text: s.anchorNode?.textContent ?? null, offset: s.anchorOffset };
    });
  await caretToStart();
  const before = await sel();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  const after = await sel();
  assert.notDeepEqual(after, before);
  step('vertical arrow navigation moves the caret');

  // Undo restores the initial document
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  s = await snap();
  assert.equal(s.text, '|ルビ(ruby)');
  step('undo restores the initial text');
} catch (e) {
  fail(e.message);
} finally {
  await app.close();
}

if (process.exitCode) {
  console.error('smoke test FAILED');
} else {
  console.log('smoke test passed');
}
