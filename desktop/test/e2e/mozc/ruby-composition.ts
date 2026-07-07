// REAL mozc composition near a ruby (Rich policy — markup hidden). Regression
// for the long-standing scramble: composing next to the OLD `display:none` ruby
// markup gave e.g. "|ルビ(ruby)" + IME "あいうえお" → "|あルいうえおビ(ruby)", and a
// caret at a ruby boundary threw the IME box to the viewport corner.
//
// The markup-out-of-DOM redesign (architecture.md "verified dead ends") fixes BOTH at the root: a ruby holds
// editable base/reading text and the delimiters are never DOM text, so an IME
// always composes into real, full-size text with a real caret rect — there is no
// zero-sized markup beside the caret to scramble it. Verified against the real
// IME, which CDP's `Input.imeSetComposition` could NOT reproduce (it scrambles
// differently). The cases (with the boundary/atom spec) live in
// ruby-composition.cases.ts; this file is the generic runner.
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while it
// runs — don't type. Run: `node test/e2e/mozc/ruby-composition.ts`.
import assert from 'node:assert/strict';
import { fail, finish, setCaret, setDoc, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';
import { cases, liveCases } from './ruby-composition.cases.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('ruby-composition (skipped)');
  process.exit(0);
}

const m = await openMozc();
const { page } = m;
const setMode = async (digit: string) => {
  await page.keyboard.down('Control');
  await page.keyboard.press(`Digit${digit}`);
  await page.keyboard.up('Control');
  await page.waitForTimeout(150);
};
const setup = async (base: string, off: number) => {
  await setDoc(page, base, 200);
  await setCaret(page, off, 150);
};

try {
  const failures: string[] = [];
  for (const c of cases) {
    await setMode(c.mode);
    await setup(c.base, c.off);
    await m.escape();
    await m.type(c.romaji);
    const got = await m.commit();
    if (got === c.want) step(`mozc ${c.romaji} ${c.label}: ${JSON.stringify(got)}`);
    else failures.push(`✗ mozc "${c.romaji}" ${c.label}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.want)}`);
  }
  for (const c of liveCases) {
    await setMode('4');
    await setup(c.base, c.off ?? 0);
    if (c.nav === 'home') {
      await page.keyboard.press('Home');
      await page.waitForTimeout(150);
    }
    await m.escape();
    const live = await m.type(c.romaji);
    const got = await m.commit();
    const okLive = live === c.wantLive;
    const okCommit = got === c.want;
    if (okLive && okCommit) step(`mozc ${c.romaji} ${c.label}: live+commit ${JSON.stringify(got)}`);
    else
      failures.push(
        `✗ mozc "${c.romaji}" ${c.label}: live ${JSON.stringify(live)} (want ${JSON.stringify(c.wantLive)}), commit ${JSON.stringify(got)} (want ${JSON.stringify(c.want)})`,
      );
  }
  assert.equal(failures.length, 0, `${failures.length} mozc-near-ruby case(s) wrong:\n${failures.join('\n')}`);
  step('real mozc: cursor steps through the base, IME adds to it when inside, stays out at boundaries');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('ruby-composition e2e (real mozc)');
