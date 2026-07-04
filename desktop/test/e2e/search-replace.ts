// Search & replace: Ctrl+F opens the bar (Ctrl+R opens it on the replace
// field — main drops the default menu so the chord is NOT a page reload),
// matches are VIEW-ONLY decorations over the plain string (highlight-all
// toggleable, the active match distinct), Enter/Shift+Enter cycle and move the
// model selection, replace / replace-all edit the plain string exactly and are
// undoable. The model text never changes from highlighting alone.
// Usage: node test/e2e/search-replace.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { docText, fail, finish, launchVed, setDoc, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

type W = { __vedCaret(): number; __vedAnchor(): number };
const caret = () => page.evaluate(() => (window as unknown as W).__vedCaret());
const anchor = () => page.evaluate(() => (window as unknown as W).__vedAnchor());
const count = (sel: string) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const activeElemId = () => page.evaluate(() => document.activeElement?.id ?? '');
const counterText = () => page.textContent('#search-count');

// 'ねこ' appears three times: plain text (3..5), plain text (10..12), and
// INSIDE a ruby reading (16..18 — the plain string contains the markup, so
// matching sees the reading like any other characters).
const TEXT = 'ある日ねこが来た。\nねこは|猫(ねこ)である。\n犬も来た。';

try {
  await page.click('#editor-content');
  await setDoc(page, TEXT);
  assert.equal(await docText(page), TEXT, 'fixture in place');

  // Ctrl+F opens the bar on the search field (a REAL key press — the window
  // chord listener, not a synthetic dispatch).
  await page.keyboard.press('Control+f');
  await page.waitForSelector('#search-input');
  assert.equal(await activeElemId(), 'search-input', 'Ctrl+F focuses the search field');
  step('Ctrl+F opens the search bar');

  await page.fill('#search-input', 'ねこ');
  await page.waitForTimeout(150);
  assert.equal(await counterText(), '1/3', 'three matches, first active');
  assert.equal(await count('.vedSearchMatch'), 3, 'highlight-all (default on) paints every match');
  assert.equal(await count('.vedSearchActive'), 1, 'exactly one active-match highlight');
  assert.equal(await anchor(), 3, 'first match selected (anchor)');
  assert.equal(await caret(), 5, 'first match selected (head)');
  assert.equal(await docText(page), TEXT, 'highlighting never touches the model');
  step('matches counted, highlighted (incl. inside a ruby reading), first selected');

  // Enter cycles forward, Shift+Enter back; the model selection follows.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  assert.equal(await counterText(), '2/3', 'Enter advances the active match');
  assert.equal(await anchor(), 10, 'second match selected (anchor)');
  assert.equal(await caret(), 12, 'second match selected (head)');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  assert.equal(await counterText(), '3/3', 'Enter reaches the ruby-reading match');
  assert.equal(await anchor(), 16, 'reading match selected (anchor)');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Shift+Enter');
  await page.waitForTimeout(100);
  assert.equal(await counterText(), '1/3', 'Shift+Enter cycles back to the first match');
  step('Enter / Shift+Enter cycle matches and move the selection');

  // Highlight-all is an option: off leaves only the active match painted.
  await page.click("button[title='Highlight all matches']");
  await page.waitForTimeout(120);
  assert.equal(await count('.vedSearchMatch'), 1, 'highlight-all off: only the active match');
  assert.equal(await count('.vedSearchActive'), 1, 'the active highlight stays');
  await page.click("button[title='Highlight all matches']");
  await page.waitForTimeout(120);
  assert.equal(await count('.vedSearchMatch'), 3, 'highlight-all back on: every match again');
  step('highlight-all toggles between every match and the active one');

  // Replace the current (first) match; the active index then names the
  // following match, which gets selected.
  await page.fill('#search-replace-input', 'いぬ');
  await page.click("button[title^='Replace the current match']");
  await page.waitForTimeout(150);
  const afterOne = 'ある日いぬが来た。\nねこは|猫(ねこ)である。\n犬も来た。';
  assert.equal(await docText(page), afterOne, 'replace edits the plain string exactly');
  assert.equal(await counterText(), '1/2', 'two matches remain, the following one active');
  assert.equal(await anchor(), 10, 'the following match is selected');
  step('replace-one edits the text and advances to the next match');

  // A separate undo entry for the replace-all (the history debounce is 500ms).
  await page.waitForTimeout(600);

  await page.click("button[title='Replace all matches']");
  await page.waitForTimeout(150);
  const afterAll = 'ある日いぬが来た。\nいぬは|猫(いぬ)である。\n犬も来た。';
  assert.equal(await docText(page), afterAll, 'replace-all rewrites every match, ruby reading included');
  assert.equal(await counterText(), '0/0', 'no matches remain');
  step('replace-all rewrites every match in one step');

  // Both replaces are plain-string edits in history: undo pops them one at a time.
  await page.click('#editor-content');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert.equal(await docText(page), afterOne, 'undo reverts the whole replace-all as one entry');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert.equal(await docText(page), TEXT, 'a second undo reverts the single replace');
  step('replace and replace-all are undoable (one history entry each)');

  // Esc (from the editor — the global chord) closes the bar and the editor
  // keeps focus; highlights disappear with it.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  assert.equal(await count('#search-input'), 0, 'Esc closes the bar');
  assert.equal(await count('.vedSearchMatch'), 0, 'highlights are gone with the bar');
  assert.equal(await activeElemId(), 'editor-content', 'focus is back in the editor');
  step('Esc closes the bar, drops the highlights, refocuses the editor');

  // Ctrl+R opens the bar on the REPLACE field — and does NOT reload the page
  // (the default menu's reload accelerator is gone; the document survives).
  await page.keyboard.press('Control+r');
  await page.waitForSelector('#search-replace-input');
  assert.equal(await activeElemId(), 'search-replace-input', 'Ctrl+R focuses the replace field');
  assert.equal(await docText(page), TEXT, 'no reload happened — the document is intact');
  step('Ctrl+R opens the bar on the replace field (no window reload)');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('search & replace e2e');
