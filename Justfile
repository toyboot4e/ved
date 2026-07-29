# Just a task runner:
# https://github.com/casey/just

# shows this help message
help:
    @just -l

# runs everything locally
all:
    nix flake check
    just test-all

[private]
alias a := all

# builds the app (typecheck + electron-vite build)
build:
    bun run build

[private]
alias b := build

# runs checks
ci:
    bun run typecheck
    bun run check
    bun run test
    bun run build

# runs biome check --fix
check:
    bun run check:fix

[private]
alias c := check

# runs biome check --fix ignoring errors
check-force:
    bun run check:fix --format-with-errors true --diagnostic-level error

[private]
alias cf := check-force

# starts the desktop development server (HMR)
dev:
    bun run dev

[private]
alias d := dev

# starts the @ved/web preview site (Vite dev server on http://localhost:5173)
serve:
    bun run dev:web

[private]
alias web := serve

[private]
alias w := serve

# installs dependencies (also downloads the Electron binary)
install:
    bun install

[private]
alias i := install

# previews the built app
run:
    bun run start

[private]
alias r := run

# runs the end-to-end smoke test against the built app. Drivers run in
# parallel with isolated profiles (VED_SMOKE_JOBS=1 for the old serial run);
# visible windows map on a private Xvfb display when the host has one
# (VED_SMOKE_NO_XVFB=1 forces the real display).
smoke: build
    bun run smoke

[private]
alias s := smoke

# runs the EXPLORATORY caret-navigation fuzz (on-demand; NOT part of `just smoke`).
# Stops on the first invariant violation, printing a seed to reproduce. Args:
# `[seed] [iters|duration]` — duration like 5m/30m/90s for a long soak, e.g.
# `just fuzz`, `just fuzz 7`, `just fuzz '' 30m`.
fuzz *args: build
    bun run --cwd desktop fuzz {{args}}

# runs the unit tests; with NO test-name also runs the full E2E suite, so a bare
# `just test` covers everything (`just test cursor-map` stays a fast unit filter)
test *args:
    bun run test {{args}} {{ if args == "" { "&& just smoke" } else { "" } }}

[private]
alias t := test

# starts the vitest UI dashboard server (unit tests): filterable describe/it tree,
# per-test pass/fail + duration, re-runs on save. Open http://localhost:51204/ in a
# browser (or use `test-ui-open`). `just test-ui cursor-map` filters by test name.
test-ui *args:
    bun x vitest --ui {{args}}

[private]
alias tu := test-ui

# runs unit tests, typecheck, lint, build, and the smoke test
test-all:
    bun run test && bun run check && just smoke

[private]
alias ta := test-all

# regenerates the API reference — the `ved` extension API plus the internal
# seams (@ved/editor, @ved/vim, the IPC contract) — from the entry files'
# TypeScript via ox-content's OXC extraction, and builds the static site
# (docs/api/ Markdown, out/api-docs/ HTML). Fails on extraction diagnostics.
doc:
    bun run api-docs

# serves the API reference on a Vite dev server (http://localhost:5273) and
# opens it in the browser; re-extracts whenever a documented source changes
doc-open:
    bun run api-docs:serve

[private]
alias do := doc-open

# regenerates the Vim keybinding reference (vim/docs/keybindings.{json,md}) by
# joining Vim's own index.txt against @ved/vim's declared binding catalog
vim-keys:
    bun run --cwd vim keybindings

[private]
alias vk := vim-keys

# typechecks both the node and web tsconfigs
typecheck:
    bun run typecheck

[private]
alias tc := typecheck

# refreshes flake.nix's bunDeps.hash from the current bun.lock. Run after any
# lockfile change, or `nix flake check` fails with a hash mismatch (or an
# offline install error inside the sandbox). Builds the deps FOD with a fake
# hash and writes the `got:` hash back; restores the old hash if the build
# fails otherwise.
bump-hash:
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{justfile_directory()}}
    system=$(nix eval --impure --raw --expr 'builtins.currentSystem')
    if ! grep -qP "^\s*$system = \"" flake.nix; then
        sed -i "s|bunDepsHash = {|bunDepsHash = {\n        $system = \"\";|" flake.nix
    fi
    old=$(grep -oP "^\s*$system = \"\K[^\"]*" flake.nix)
    sed -i "s|$system = \"$old\";|$system = \"\";|" flake.nix
    trap 'sed -i "s|$system = \"\";|$system = \"$old\";|" flake.nix' EXIT
    log=$(nix build --no-link ".#packages.$system.ved.bunDeps" 2>&1) || true
    new=$(grep -oP 'got:\s+\K\S+' <<<"$log" || true)
    if [ -z "$new" ]; then echo "$log" >&2; exit 1; fi
    trap - EXIT
    sed -i "s|$system = \"\";|$system = \"$new\";|" flake.nix
    if [ "$new" = "$old" ]; then
        echo "bunDeps.hash already up to date: $new"
    else
        echo "bunDeps.hash: $old -> $new"
    fi

[private]
alias bh := bump-hash

# updates dependency versions aggressively. It can fail.
update:
    bun x npm-check-updates -u && bun install && just bump-hash

# creates a new electron-vite project. This is just a note.
[private]
create:
    bun create @quick-start/electron@latest
