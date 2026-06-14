# Packaging: Electron now, Tauri worth trying later

---
status: accepted
---

ved ships on Electron. Tauri is a credible future alternative worth a trial,
but not now. The two are orthogonal to the editor framework (ADR 0002) and to
the render-engine decision (ADR 0001 stands either way — both are still
browser/CSS, not a custom engine): any of Slate/Lexical run under both.

## Why Electron now

- **One engine on every desktop.** Electron bundles Chromium, so vertical
  layout, ruby, caret behavior, and IME timing are identical on
  Windows/macOS/Linux — and that single engine is exactly what all of ved's
  IME and ruby/caret tuning is calibrated against.
- **It already works**, including the NixOS/X11 fcitx5 + mozc setup
  (`flake.nix` GTK immodules cache, Wayland IME switches in `src/main`).

## Why Tauri is worth a future try

- **Footprint.** A system-WebView app is ~10 MB vs Electron's ~200 MB.
- **Native Linux IME.** A Tauri app is a real GTK app, so fcitx5/mozc works
  natively — without the bundled-Chromium immodules-cache workaround.
- **Renderer ports largely as-is** (same CSS `writing-mode`, same React).

## The cost that defers it

Tauri uses the *system* WebView — three different engines: WebView2
(Chromium, fine), WKWebView (decent), and on Linux **WebKitGTK**, the weakest
at `vertical-rl` + contenteditable. Everything hand-tuned against Chromium
(caret clusters, `Selection.modify`, ruby pairing, IME composition timing)
would need re-validation **per engine**. For a typography-critical editor,
one engine everywhere is worth a lot.

## If/when we try it

Spike first, same methodology as the other ceilings: run the Playwright
caret-walk + ruby-geometry checks under WKWebView and WebKitGTK before
committing. Adopt only if both clear the bar.
