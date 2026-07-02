// The debug view-config controls (toolbar "View" group) must restyle the
// editor live: font size / line-space ratio / page geometry land as CSS
// custom properties on the app root (view-config.ts), and the editor's page
// box follows. Reset returns to the defaults.
// Usage: node test/e2e/view-config.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed();
const { page } = ved;

const contentStyle = () =>
  page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const cs = getComputedStyle(content);
    const rect = content.getBoundingClientRect();
    return {
      fontSize: Number.parseFloat(cs.fontSize),
      lineHeight: Number.parseFloat(cs.lineHeight),
      fontFamily: cs.fontFamily,
      pageLineChars: Number.parseFloat(cs.getPropertyValue('--page-line-chars')),
      width: rect.width,
      height: rect.height,
    };
  });

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1, `${what}: ${actual} ≈ ${expected}`);

// $line-gutter = 2.2 * 18px, deliberately compile-time (editor.module.scss)
const GUTTER = 2.2 * 18;

try {
  // Launch defaults (VerticalColumns): 18px cell, 0.55 leading, 40字 × 20行
  const initial = await contentStyle();
  near(initial.fontSize, 18, 'default font size');
  near(initial.lineHeight, 18 * 1.55, 'default line pitch');
  near(initial.height, 40 * 18 + GUTTER, 'default page height (40 cells + gutter)');
  step('defaults render (18px, 0.55, 40×20)');

  // Font size drives the cell: the line pitch and the page box scale with it
  await page.fill('#view-config-fontSize', '24');
  await page.waitForTimeout(150);
  let s = await contentStyle();
  near(s.fontSize, 24, 'font size follows the input');
  near(s.lineHeight, 24 * 1.55, 'line pitch scales with the cell');
  near(s.height, 40 * 24 + GUTTER, 'page height scales with the cell');
  step('font size input rescales cell, pitch, and page');

  // Line-space ratio drives the pitch (and the page width = lines × pitch)
  await page.fill('#view-config-lineSpaceRatio', '1');
  await page.waitForTimeout(150);
  s = await contentStyle();
  near(s.lineHeight, 24 * 2, 'line pitch follows the ratio');
  // width = lines × pitch + the rt allowance (one cell across both sides)
  near(s.width, 20 * 24 * 2 + 24, 'page width = lines × pitch + rt allowance (VerticalColumns)');
  step('line-space ratio input rescales the pitch');

  // Page geometry: cells per line and lines per page
  await page.fill('#view-config-pageLineChars', '20');
  await page.fill('#view-config-pageLines', '10');
  await page.waitForTimeout(150);
  s = await contentStyle();
  assert.equal(s.pageLineChars, 20, '--page-line-chars follows the input');
  near(s.height, 20 * 24 + GUTTER, 'page height follows cells per line');
  near(s.width, 10 * 48 + 24, 'page width follows lines per page (plus rt allowance)');
  step('page geometry inputs resize the page box');

  // Out-of-range input is clamped at CSS generation (raw value stays typable)
  await page.fill('#view-config-fontSize', '3');
  await page.waitForTimeout(150);
  s = await contentStyle();
  near(s.fontSize, 8, 'font size clamps to the lower bound');
  step('out-of-range font size clamps instead of breaking the layout');

  // Font family applies to the editor content only; empty inherits
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  const chromeFont = () =>
    page.evaluate(() => getComputedStyle(document.querySelector('button[aria-label="Horizontal"]')!).fontFamily);
  const chromeFontBefore = await chromeFont();
  await page.fill('#view-config-fontFamily', 'monospace');
  await page.waitForTimeout(150);
  s = await contentStyle();
  assert.equal(s.fontFamily, 'monospace', 'editor font follows the input');
  assert.equal(await chromeFont(), chromeFontBefore, 'shell chrome keeps its font');
  await page.fill('#view-config-fontFamily', '');
  await page.waitForTimeout(150);
  s = await contentStyle();
  assert.equal(s.fontFamily, bodyFont, 'empty font input inherits the app stack');
  step('font family applies to editor content only and inherits when empty');

  // Reset restores every default
  await page.click('#view-config-reset');
  await page.waitForTimeout(150);
  s = await contentStyle();
  near(s.fontSize, 18, 'reset font size');
  near(s.lineHeight, 18 * 1.55, 'reset line pitch');
  near(s.height, 40 * 18 + GUTTER, 'reset page height');
  step('reset returns to the defaults');

  // The editor still edits after a restyle (the config is pure view)
  await page.click('#editor-content');
  await page.keyboard.insertText('あ');
  await page.waitForTimeout(150);
  const text = await page.evaluate(() => document.getElementById('editor-content')!.textContent);
  assert.ok(text?.includes('あ'), 'typing works after view-config changes');
  step('editing still works after view-config changes');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('view-config e2e');
