# Writing an editor extension

An extension adds behavior to `@ved/editor` — modal keymaps, custom commands,
caret styling — through one seam: the `extensions` prop. `@ved/vim` is the
reference implementation; everything it does goes through the API below, so
anything it does, yours can.

## The shape

```ts
import type { EditorExtension } from '@ved/editor';

export const myExtension: EditorExtension = {
  id: 'my-ext', // unique; namespace your command ids under it
  attach(ctx) {
    // runs when the editor attaches you; close over `ctx`
    const unregister = ctx.registerCommand('my-ext.hello', () => {
      ctx.replaceRange(0, 0, 'こんにちは');
      return true;
    });
    return {
      handleKey: (event) => {
        // every non-IME keydown, BEFORE the editor's own handling.
        // Return true to consume; false to let it bubble (REQUIRED for
        // chords you don't bind — Ctrl+O/S are app shortcuts).
        return false;
      },
      handleTextInput: (data) => false, // true blocks a plain insertion
      onCompositionStart: () => {}, // observe only — never edit here
      onCompositionEnd: () => {}, // edits are legal again here
      detach: () => unregister(), // undo your side effects
    };
  },
};
```

Hand it to the editor with a **stable identity** — the prop is reconciled by
identity, so build the array once (module constant), not per render:

```tsx
const EXTS = [myExtension];
<VedEditor … extensions={enabled ? EXTS : NO_EXTS} />;
```

## The contract

- **The document is a plain string; a position is a plain offset.** `getText`,
  `getSelection`, `replaceRange`, `setSelection` speak nothing else. You never
  see the rich (ProseMirror) document, so you cannot desync it: edits take the
  editor's exact plain-string path (canonical rebuild + ruby repair + undo
  history), selections snap to legal caret stops.
- **Movement is the editor's, not yours — and axis-agnostic.**
  `moveCaret('char'|'line', dir)` is LOGICAL: the editor rotates it to the
  physical axis per writing mode (a `'line'` step is the next/previous column
  in vertical-rl), applying ruby stops and the goal column. Map your movement
  keys straight onto it and never think about writing direction (Vim's j/k =
  `'line'`, h/l = `'char'`). `caretStop(offset, dir)` answers "where would one
  step land" without moving; compute word/line targets over `getText()` and
  land them with `setSelection` — it clamps and snaps for you.
  `scrollPage(dir, half?)` is a viewport turn that carries the caret along.
- **IME is sacrosanct, and the seam enforces it.** Your hooks never see
  composing input; every mutator refuses while `isComposing()`; attach/detach
  waits out a live composition. If your semantics reject composed text (a
  modal normal mode), snapshot at `onCompositionStart` and restore at
  `onCompositionEnd` — never interfere between the two.
- **Styling**: `setCaretShape('block')` for a modal cursor (falls back to the
  bar where no visible character sits under the caret), `setContentClass` for
  your own CSS hooks (it survives writing-mode/policy switches). Undo
  grouping: `breakUndoGroup()` at your semantic boundaries.

## Model/view split (recommended)

Keep your semantics a pure reducer over `(state, key, {text, selection,
caretStop})` returning effects, and let a thin adapter apply effects through
the context — `@ved/vim` (`vim/src/model.ts` vs `vim/src/extension.ts`). The
reducer unit-tests as plain functions; the adapter is small enough to verify
end-to-end (`desktop/test/e2e/vim-mode.ts` is the template — new extensions
with UI need such a driver, and any new dialog its `VED_SMOKE_*` seam).

## Package setup

An in-repo extension is a flat workspace package depending only on
`@ved/editor`'s public entry (`"@ved/editor": "workspace:*"`; never deep-import
its internals — pnpm isolation and Biome both block prosemirror imports).
Declare the asset-import shapes (`src/env.d.ts`, copy vim's), add the package
to `pnpm-workspace.yaml`, root `tsconfig.json` references, `vitest.config.ts`
projects, and the Biome prosemirror-restriction override. After
`pnpm install`, refresh the Nix hash: `just bump-hash`.
