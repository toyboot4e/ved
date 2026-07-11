# Plan: auto-update

Status: **not started** (2026-07). Blocked on nothing for phases 0–3; phase 4
(macOS) has an external prerequisite (Apple Developer Program membership).

Goal: on startup the packaged app checks for a newer release; if the user
confirms, it downloads, installs, terminates itself, and relaunches when asked
to. Covered targets: Windows (NSIS installer **and** portable exe), macOS
(dmg/zip), Linux (AppImage, deb; snap delegates to snapd).

## Overall strategy

**`electron-updater` for every target it supports; one small hand-rolled
updater for the Windows portable exe; explicit no-op everywhere else.**

We already build with electron-builder, and electron-updater consumes exactly
the metadata electron-builder emits (`latest.yml` / `latest-mac.yml` /
`latest-linux.yml` + artifacts on a release feed). The one gap is the Windows
*portable* target, which electron-updater refuses by design (nothing is
"installed", so there is nothing for an installer to update). There we
hand-roll the smallest possible updater: read the **same** `latest.yml`,
download the portable exe, verify its sha512, and swap the running exe via the
Windows rename trick (a running exe can be renamed, not overwritten).

The feed is **GitHub Releases** (`github.com/toyboot4e/ved`): free, no server
to run, and electron-builder publishes to it natively. Caveat: the releases
must be publicly readable — electron-updater cannot authenticate against a
private repo without embedding a token in the app. If the repo stays private,
publish releases to a separate public repo or switch `publish` to a
`generic` static-file server; nothing else in this plan changes.

### Target matrix

| Target            | Check + download        | Install + relaunch                                 |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Windows NSIS      | electron-updater        | `quitAndInstall(silent, runAfter)`                 |
| Windows portable  | hand-rolled (same feed) | rename-swap exe, spawn new, quit                   |
| macOS dmg + zip   | electron-updater        | `quitAndInstall` (Squirrel.Mac; **signed only**)   |
| Linux AppImage    | electron-updater        | replaces the AppImage file in place, relaunches    |
| Linux deb         | electron-updater ≥6.3   | `pkexec`-driven package install (password prompt)  |
| Linux snap        | none in-app             | snapd refreshes on its own; updater is a no-op     |
| dev / unpackaged  | disabled                | (`!app.isPackaged`; e2e overrides via seam)        |

## Architecture decisions

### 1. All updater code lives in the main process

`desktop/src/main/update-service.ts`, behind the typed IPC contract in
`src/shared/ipc.ts` (same pattern as `file-service.ts`). The renderer only
ever sees plain events and commands:

```ts
// additions to src/shared/ipc.ts (sketch)
type UpdateInfo = { version: string; notes?: string };
type UpdateEvent =
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; info: UpdateInfo }
  | { kind: 'error'; message: string };
type VedUpdateApi = {
  onUpdateEvent(cb: (e: UpdateEvent) => void): Unsubscribe;
  downloadUpdate(): Promise<void>;
  installUpdate(relaunch: boolean): Promise<void>; // terminates the app
};
```

The service picks a backend at startup: electron-updater (NSIS, mac,
AppImage, deb), the portable updater (`process.env.PORTABLE_EXECUTABLE_FILE`
is set — electron-builder's portable launcher provides it), or the null
backend (snap via `process.env.SNAP`, unpackaged, unwritable install).

### 2. The prompt is renderer UI, not a native dialog

A passive banner/toast drawn in React: "vX.Y.Z is available — Download /
Later", then "Restart to update / On next quit". Two reasons:

- **Dialog test seams.** Playwright cannot drive native dialogs; a renderer
  banner is directly scriptable, so the e2e smoke test exercises the real UX.
- **IME safety.** The banner must never steal focus or force layout on the
  editor — it appears alongside, is keyboard-reachable but never
  auto-focused, and defers any focus movement while a composition is live.

### 3. Consent-first flow (`autoDownload = false`), informed consent

**The banner must show the new version number and the release notes before
the user consents to anything** — this is a requirement, not polish. The
banner header carries `current → new` versions; an expandable panel shows the
notes as plain text (no markdown rendering at first; a "view on GitHub" link
covers rich formatting). Startup check runs a few seconds after the window
shows. Nothing downloads without a click; nothing installs without a second
click. "On next quit" leans on electron-updater's `autoInstallOnAppQuit`
(NSIS/mac). The relaunch choice maps to
`quitAndInstall(isSilent = true, isForceRunAfter = relaunch)`.

Where the notes come from: electron-updater's GitHub provider delivers the
release body as `releaseNotes` on its own. The portable updater (and any
`generic` feed) reads `releaseNotes` from `latest.yml` itself — electron-
builder embeds it when the release workflow passes `releaseInfo`
(`--config.releaseInfo.releaseNotesFile=...`), so the feed file is the single
source and no extra API call is needed. Notes missing → the banner still
shows the versions plus the release-page link; the update is never blocked on
notes, only on consent.

### 4. One feed, one metadata format — including portable

Build NSIS and portable in the same `--win` run: `latest.yml` then lists both
artifacts with sha512 hashes, and the portable updater picks its artifact by
name (`*-portable.exe` via `portable.artifactName`). No second feed, no
custom manifest. The portable updater needs only: an https fetch, a YAML
parse (`yaml` dependency — the file is small and stable), a semver compare
against `app.getVersion()`, and the swap.

### 5. Tests are self-contained — no stale install, no real newer release

Every automated test fabricates its whole world locally; none needs an old
ved installed or a second release published.

- `VED_UPDATE_FEED_URL` — overrides the feed with a local http server run by
  the e2e driver. The driver **writes** the `latest.yml` it serves: a version
  bumped above `app.getVersion()`, fabricated release notes, an artifact it
  generated on the spot, and the sha512 it computed over that artifact.
  Combined with `autoUpdater.forceDevUpdateConfig`, the check/download/notes
  path runs end-to-end in the unpackaged smoke build.
- `VED_SMOKE_UPDATE_NO_INSTALL=1` — `installUpdate` records
  `__vedUpdateInstallRequested = { version, relaunch }` instead of actually
  installing, so the smoke suite asserts the terminal step without killing
  itself.
- **One-build install trick** for the real install paths: package the
  current build once, then serve **its own artifact back to it** under a
  fabricated higher version. Check, notes, download, sha512 verification,
  and the actual install/swap/relaunch all run for real — no second version
  exists anywhere. The relaunched app reports the same version string, so
  the assertion is on the swap's side effects (artifact file replaced —
  compare mtime/inode/hash — plus the relaunch marker), not on the version.
  This is a separate packaged-build driver (`test/e2e/update-install.ts`),
  not part of `just smoke` (packaging is slow); CI runs it per platform.
- The portable swap is orchestration around injected primitives
  (fetch/rename/move/spawn/quit) — unit-tested with fakes on any OS. Its
  Windows-specific claim (renaming a running exe) is covered by the
  one-build driver on the Windows CI runner.

The manual release checklist (phase 5) shrinks to what genuinely cannot be
fabricated: a cross-version update from the previous *published* release,
once per release, per platform.

## Prerequisites — must land before the FIRST public release

- [ ] `appId` → `io.github.toyboot4e.ved` (changing it after a release breaks
      the update chain and the NSIS install identity).
- [ ] `publish` → `{ provider: github, owner: toyboot4e, repo: ved }`
      (currently a `generic` placeholder pointing at example.com).
- [ ] macOS `target: [dmg, zip]` — Squirrel.Mac updates from the **zip**;
      dmg is only for first installs.
- [ ] Windows `target: [nsis, portable]` with a distinct
      `portable.artifactName` (e.g. `${name}-${version}-portable.${ext}`).
- [ ] Real `linux.maintainer` (deb metadata), real `mac.category`.

## Phases

Each phase is independently shippable and ends with `just test-all` green.

### Phase 0 — groundwork (no behavior change)

The prerequisite checklist above, plus the `electron-updater` and `yaml`
dependencies. Verify `pnpm build:unpack` and a Linux `--linux` build still
produce artifacts.

### Phase 1 — check + notify (all platforms, zero installer risk)

`update-service.ts` with the check only: on `available`, the renderer banner
shows `current → new` **and the release notes**, and offers **Open download
page** (`shell.openExternal` to the release URL — via a main-process IPC
handler; the URL derives from the feed, not renderer input). Suppressed for
snap and unpackaged runs. E2e: driver fabricates a feed → banner appears →
assert the fabricated version and notes are shown verbatim → confirm →
assert the open-external seam. This already delivers "the app finds newer
versions on startup" everywhere.

### Phase 2 — full flow for electron-updater targets

NSIS, AppImage, deb: `downloadUpdate()` with progress in the banner, then the
restart prompt and `quitAndInstall`. Differential downloads (blockmap) come
free on NSIS and AppImage. Smoke extends the phase-1 test through download
and asserts `__vedUpdateInstallRequested`; the packaged one-build driver
(`test/e2e/update-install.ts`, AppImage first) proves the real
replace-and-relaunch with no second release.

### Phase 3 — Windows portable updater

`portable-updater.ts`: check via `latest.yml`, download to a temp file,
verify sha512, then swap — rename `ved.exe` → `ved.exe.old`, move the new exe
into place, spawn it detached, quit; delete stale `*.old` on next startup.
If the exe's directory is not writable (USB stick mounted read-only, admin
locations), degrade to the phase-1 notify-only banner. Unit tests with
injected primitives on any OS; the one-build driver on a Windows runner
proves the live rename-swap.

### Phase 4 — macOS signing + notarization (external prerequisite)

electron-updater refuses unsigned apps on macOS, so until this phase macOS
stays at phase-1 notify-only. Needs: Apple Developer Program membership,
a Developer ID Application certificate, `notarize: true` +
`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` (or an App Store
Connect API key) in the build environment, hardened runtime with the existing
entitlements. Then enable the full phase-2 flow on mac and verify a real
update (Squirrel.Mac relaunches automatically).

### Phase 5 — release pipeline + checklist

GitHub Actions workflow on `v*` tags: a 3-OS matrix running
`electron-builder --publish always` into a **draft** release (mac signing
secrets injected; snap dropped from CI until a snapcraft account exists),
plus a job per platform running the packaged one-build install driver. The
release workflow passes `releaseInfo.releaseNotesFile` so the notes land in
the feed files, not just the GitHub release body. A
`docs/release-checklist.md` with the one remaining manual step — a
cross-version update from the previous published release per platform —
and the SmartScreen note for unsigned Windows builds
(auto-update works; first installs warn until we buy a Windows cert —
optional, unlike macOS).

### Phase 6 — polish (optional, unordered)

- Settings: check-on-startup toggle; "skip this version".
- A manual "Check for updates" command in the palette/menu.
- Markdown rendering for the notes panel (plain text until then).
