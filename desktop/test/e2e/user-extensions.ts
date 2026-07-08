// User extensions end to end (docs/extensions.md): a fixture
// init.ts in an isolated `--config-dir` registers a namespaced command,
// binds a chord to it, and adds a raw key hook; the driver exercises both
// paths through real keydowns and checks the generated typing files
// (ved.d.ts + tsconfig.json) appear next to the fixture.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSeams } from './harness.ts';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

// The fixture uses the API exactly as a user would: `import type` from
// 'ved' (types-only — stripped with the types), commands.register under the
// extension's own namespace, keybindings.bind with a lowercase chord spec.
const INIT_TS = `import type { VedContext } from 'ved';

export async function activate(ctx: VedContext): Promise<void> {
  // Persistence: the SECOND activation (the hot reload) reads what the first
  // one wrote — the driver asserts P7 after the reload.
  const prev = await ctx.storage.read('count.txt');
  ctx.ui.statusItem({ text: 'P' + (prev ?? '無') });
  await ctx.storage.write('count.txt', '7');
  ctx.commands.register('stamp', () => {
    const end = ctx.editor.text().length;
    return ctx.editor.replaceRange(end, end, '拡張OK');
  });
  ctx.keybindings.bind('mod+7', 'init.stamp');
  ctx.editor.addHooks({
    handleKey: (event) => {
      if (event.key !== '8' || !(event.ctrlKey || event.metaKey)) return false;
      ctx.editor.replaceRange(0, 0, 'フック');
      return true;
    },
  });

  ctx.ui.statusItem({ text: '状態OK', title: 'user extension status' });

  const panel = ctx.ui.panel({ title: '拡張パネル' });
  panel.element.textContent = 'パネル内容';
  ctx.commands.register('showPanel', () => panel.show());
  ctx.keybindings.bind('mod+5', 'init.showPanel');

  ctx.commands.register('pick', async () => {
    const picked = await ctx.ui.quickPick(['甲', '乙', '丙'], { label: (s) => s, placeholder: '選ぶ…' });
    if (picked !== null) ctx.editor.replaceRange(0, 0, '選択:' + picked);
  });
  ctx.keybindings.bind('mod+6', 'init.pick');

  const selStatus = ctx.ui.statusItem({ text: 'S-' });
  ctx.editor.onDidChangeSelection((sel) => selStatus.update({ text: 'S' + sel.head }));

  ctx.commands.register('mark', () => {
    ctx.editor.decorate([{ from: 0, to: 2, class: 'hl' }]);
    return true;
  });
  ctx.keybindings.bind('mod+0', 'init.mark');
}
`;

const configDir = await mkdtemp(join(tmpdir(), 'ved-ext-e2e-'));
await mkdir(join(configDir, 'extensions'), { recursive: true });
await writeFile(join(configDir, 'extensions', 'init.ts'), INIT_TS, 'utf-8');

// A PROJECT extension: a directory with a manifest and a relative import —
// esbuild bundles the graph in main (docs/extensions.md "How loading works").
const projectDir = join(configDir, 'extensions', 'counter');
await mkdir(join(projectDir, 'src'), { recursive: true });
await writeFile(
  join(projectDir, 'package.json'),
  JSON.stringify({ name: 'counter', ved: { id: 'counter', entry: 'src/main.ts' } }),
  'utf-8',
);
await writeFile(join(projectDir, 'src', 'util.ts'), 'export const double = (n: number): number => n * 2;\n', 'utf-8');
await writeFile(
  join(projectDir, 'src', 'main.ts'),
  `import type { VedContext } from 'ved';
import { double } from './util.ts';
export function activate(ctx: VedContext): void {
  ctx.commands.register('go', () => {
    const end = ctx.editor.text().length;
    return ctx.editor.replaceRange(end, end, double(21) + '計');
  });
  ctx.keybindings.bind('mod+9', 'counter.go');
}
`,
  'utf-8',
);

const ved = await launchVed({
  // The fixture edits the buffer — the close guard needs the discard stub.
  env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }),
  args: () => [`--config-dir=${configDir}`],
});
const { page } = ved;
const text = () => page.evaluate(() => (window as unknown as ModelSeams).__vedText());

try {
  // Extensions load in a startup effect; the first assertions poll for it.
  let stamped = false;
  for (let i = 0; i < 50 && !stamped; i++) {
    await pressMod(page, '7');
    await page.waitForTimeout(100);
    stamped = (await text()).includes('拡張OK');
  }
  if (stamped) step('keybinding Mod+7 ran the namespaced command init.stamp');
  else fail(`Mod+7 never produced the command's edit — got ${JSON.stringify(await text())}`);

  await pressMod(page, '8');
  await page.waitForTimeout(150);
  if ((await text()).startsWith('フック')) step('addHooks handleKey consumed Mod+8 and edited');
  else fail(`Mod+8 hook edit missing — got ${JSON.stringify(await text())}`);

  const statusItem = await page.textContent('#extension-status-items');
  if (statusItem?.includes('状態OK')) step('statusItem renders in the footer');
  else fail(`status item missing — got ${JSON.stringify(statusItem)}`);

  await pressMod(page, '5');
  await page.waitForSelector('text=パネル内容', { timeout: 3000 });
  step('panel shows the extension-owned element on show()');

  await pressMod(page, '6');
  await page.waitForSelector('#extension-quick-pick-input', { timeout: 3000 });
  await page.waitForTimeout(80); // the input focuses in a mount effect
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  if ((await text()).includes('選択:乙')) step('quickPick resolved the arrow-selected item');
  else fail(`quickPick result missing — got ${JSON.stringify(await text())}`);

  await pressMod(page, '0');
  await page.waitForTimeout(150);
  if (await page.$('.vedx-init-hl')) step('decorate() painted the namespaced highlight class');
  else fail('decoration span .vedx-init-hl missing');

  await page.evaluate(() => (window as unknown as ModelSeams).__vedSetCaret(3));
  await page.waitForTimeout(120);
  const selStatus = await page.textContent('#extension-status-items');
  if (selStatus?.includes('S3')) step('onDidChangeSelection pulled offsets through the seam');
  else fail(`selection status missing — got ${JSON.stringify(selStatus)}`);

  let counted = false;
  for (let i = 0; i < 30 && !counted; i++) {
    await pressMod(page, '9');
    await page.waitForTimeout(100);
    counted = (await text()).includes('42計');
  }
  if (counted) step('project extension bundled (relative import) and ran via its binding');
  else fail(`project extension edit missing — got ${JSON.stringify(await text())}`);

  // Hot reload: rewrite init.ts; the watcher recompiles, the renderer swaps
  // the extension in place, and the same chord runs the NEW command body.
  await writeFile(join(configDir, 'extensions', 'init.ts'), INIT_TS.replace("'拡張OK'", "'拡張二'"), 'utf-8');
  let reloaded = false;
  for (let i = 0; i < 60 && !reloaded; i++) {
    await pressMod(page, '7');
    await page.waitForTimeout(150);
    reloaded = (await text()).includes('拡張二');
  }
  if (reloaded) step('editing init.ts hot-reloaded the extension (watch → recompile → swap)');
  else fail(`hot reload never took — got ${JSON.stringify(await text())}`);

  const storageStatus = await page.textContent('#extension-status-items');
  if (storageStatus?.includes('P7')) step('ctx.storage round-tripped across the reload');
  else fail(`storage status missing — got ${JSON.stringify(storageStatus)}`);
  if ((await readFile(join(configDir, 'storage', 'init', 'count.txt'), 'utf-8')) === '7') {
    step('storage file landed under <configDir>/storage/<id>/');
  } else fail('storage file missing on disk');

  const dts = await readFile(join(configDir, 'extensions', 'ved.d.ts'), 'utf-8');
  if (dts.includes('export type VedContext')) step('generated ved.d.ts carries the API declaration');
  else fail('ved.d.ts missing or without VedContext');
  const tsconfig = JSON.parse(await readFile(join(configDir, 'extensions', 'tsconfig.json'), 'utf-8'));
  if (tsconfig.compilerOptions?.paths?.ved?.[0] === './ved.d.ts') step('generated tsconfig maps the ved specifier');
  else fail('tsconfig.json missing the ved path mapping');
} finally {
  await ved.close();
  await rm(configDir, { recursive: true, force: true });
}
finish('user-extensions');
