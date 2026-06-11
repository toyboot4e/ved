// Spike driver: measures CSS-ruby rendering and caret behavior over an
// identity text model. Run from the repo root: node spikes/identity-ruby.spike.mjs
import { _electron } from 'playwright';

const app = await _electron.launch({
  executablePath: new URL('../node_modules/electron/dist/electron', import.meta.url).pathname,
  args: [new URL('../out/main/index.js', import.meta.url).pathname],
});
const page = await app.firstWindow();
await page.goto(new URL('./identity-ruby.html', import.meta.url).href);
await page.waitForSelector('#e-fs0 [contenteditable]');

const results = await page.evaluate(() => {
  const out = {};
  out.supports = {
    ruby: CSS.supports('display', 'ruby'),
    rubyText: CSS.supports('display', 'ruby-text'),
    rubyBase: CSS.supports('display', 'ruby-base'),
  };

  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  };

  for (const id of ['h-none', 'h-fs0', 'v-fs0']) {
    const s = document.getElementById(id);
    out[id] = {
      base: rect(s.querySelector('.rb')),
      annotation: rect(s.querySelector('.rt')),
      delims: [...s.querySelectorAll('.d')].map(rect),
    };
  }

  // Caret walk: collapse at the start, then move forward character by
  // character. Records which text node + offset the selection lands on —
  // this is what Slate's DOM-point mapping has to survive.
  const walk = (rootId) => {
    const root = document.querySelector(`#${rootId} [contenteditable]`);
    root.focus();
    const sel = getSelection();
    const first = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
    sel.collapse(first, 0);
    const desc = () =>
      sel.anchorNode
        ? `${sel.anchorNode.parentElement.className || 'p'}:"${sel.anchorNode.textContent}"@${sel.anchorOffset}`
        : 'none';
    const seq = [desc()];
    for (let i = 0; i < 12; i++) {
      sel.modify('move', 'forward', 'character');
      const d = desc();
      if (d === seq[seq.length - 1]) break; // stuck
      seq.push(d);
    }
    return seq;
  };
  out.caretWalkNone = walk('e-none');
  out.caretWalkFs0 = walk('e-fs0');

  // Can a DOM selection be programmatically placed inside a hidden
  // syntax character? (Slate needs SOME representable position there.)
  const probe = (rootId) => {
    const d = document.querySelector(`#${rootId} .d`).firstChild;
    const sel = getSelection();
    try {
      sel.collapse(d, 1);
    } catch (e) {
      return `throws: ${e.message}`;
    }
    return sel.anchorNode === d
      ? `kept @${sel.anchorOffset}`
      : `moved to ${sel.anchorNode?.parentElement?.className}@${sel.anchorOffset}`;
  };
  out.selectionIntoHiddenNone = probe('e-none');
  out.selectionIntoHiddenFs0 = probe('e-fs0');

  return out;
});

console.log(JSON.stringify(results, null, 1));
await page.screenshot({ path: new URL('./identity-ruby.png', import.meta.url).pathname, fullPage: true });
await app.close();
