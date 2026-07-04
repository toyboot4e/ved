// Mod+/ toggles the appear policy ByCharacter ⇄ Rich (commands.ts
// 'appear.toggleCharRich'): ByCharacter goes to Rich, anywhere else to
// ByCharacter. Assert the round-trip from the launch default (Rich), the
// jump from Plain, and that the direct Mod+1..4 bindings still work — read
// back from the Ruby-display toolbar group's aria-pressed state.
// Usage: node test/e2e/appear-toggle.ts  (after a build; window stays hidden)
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const pressedPolicy = () =>
  page.evaluate(() => {
    const btn = document.querySelector('fieldset[aria-label="Ruby display"] button[aria-pressed="true"]');
    return btn?.textContent ?? '<none>';
  });
// Poll until the pressed button matches (the suite runs many apps; fixed waits flake).
const until = async (want: string, label: string): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    if ((await pressedPolicy()) === want) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label}: still ${await pressedPolicy()} (want ${want})`);
};
const chord = async (key: string) => {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
};

try {
  await until('Rich', 'launch default');
  step('launches in Rich');

  await chord('Slash');
  await until('Character', 'first Ctrl+/');
  step('Ctrl+/ from Rich lands on Character');

  await chord('Slash');
  await until('Rich', 'second Ctrl+/');
  step('Ctrl+/ from Character returns to Rich (round-trip)');

  // From any non-ByCharacter policy the toggle lands on Character.
  await chord('Digit1');
  await until('Plain', 'Ctrl+1');
  await chord('Slash');
  await until('Character', 'Ctrl+/ from Plain');
  step('Ctrl+/ from Plain lands on Character (direct Mod+1 binding intact)');

  await chord('Digit4');
  await until('Rich', 'Ctrl+4');
  step('direct Mod+4 binding intact');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('appear-toggle e2e');
