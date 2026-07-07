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
    pnpm run build

[private]
alias b := build

# runs checks
ci:
    pnpm run typecheck
    pnpm run check
    pnpm run test
    pnpm run build

# runs biome check --fix
check:
    pnpm run check:fix

[private]
alias c := check

# runs biome check --fix ignoring errors
check-force:
    pnpm run check:fix --format-with-errors true --diagnostic-level error

[private]
alias cf := check-force

# starts the desktop development server (HMR)
dev:
    pnpm run dev

[private]
alias d := dev

# starts the @ved/web preview site (Vite dev server on http://localhost:5173)
serve:
    pnpm run dev:web

[private]
alias web := serve

[private]
alias w := serve

# installs dependencies (also downloads the Electron binary)
install:
    pnpm install

[private]
alias i := install

# previews the built app
run:
    pnpm run start

[private]
alias r := run

# runs the end-to-end smoke test against the built app. Drivers run in
# parallel with isolated profiles (VED_SMOKE_JOBS=1 for the old serial run);
# visible windows map on a private Xvfb display when the host has one
# (VED_SMOKE_NO_XVFB=1 forces the real display).
smoke: build
    pnpm run smoke

[private]
alias s := smoke

# runs the EXPLORATORY caret-navigation fuzz (on-demand; NOT part of `just smoke`).
# Stops on the first invariant violation, printing a seed to reproduce. Args:
# `[seed] [iters|duration]` — duration like 5m/30m/90s for a long soak, e.g.
# `just fuzz`, `just fuzz 7`, `just fuzz '' 30m`.
fuzz *args: build
    pnpm -C desktop run fuzz {{args}}

# runs the unit tests; with NO test-name also runs the full E2E suite, so a bare
# `just test` covers everything (`just test cursor-map` stays a fast unit filter)
test *args:
    pnpm run test {{args}} {{ if args == "" { "&& just smoke" } else { "" } }}

[private]
alias t := test

# starts the vitest UI dashboard server (unit tests): filterable describe/it tree,
# per-test pass/fail + duration, re-runs on save. Open http://localhost:51204/ in a
# browser (or use `test-ui-open`). `just test-ui cursor-map` filters by test name.
test-ui *args:
    pnpm exec vitest --ui {{args}}

[private]
alias tu := test-ui

# runs unit tests, typecheck, lint, build, and the smoke test
test-all:
    pnpm run test && pnpm run check && just smoke

[private]
alias ta := test-all

# typechecks both the node and web tsconfigs
typecheck:
    pnpm run typecheck

[private]
alias tc := typecheck

# refreshes flake.nix's pnpmDeps.hash from the current pnpm-lock.yaml. Run
# after any lockfile change, or `nix flake check` fails with
# ERR_PNPM_NO_OFFLINE_TARBALL. Builds the deps FOD with a fake hash and writes
# the `got:` hash back; restores the old hash if the build fails otherwise.
bump-hash:
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{justfile_directory()}}
    system=$(nix eval --impure --raw --expr 'builtins.currentSystem')
    old=$(grep -oP '^\s*hash = "\K[^"]*' flake.nix)
    sed -i "s|hash = \"$old\";|hash = \"\";|" flake.nix
    trap 'sed -i "s|hash = \"\";|hash = \"$old\";|" flake.nix' EXIT
    log=$(nix build --no-link ".#packages.$system.ved.pnpmDeps" 2>&1) || true
    new=$(grep -oP 'got:\s+\K\S+' <<<"$log" || true)
    if [ -z "$new" ]; then echo "$log" >&2; exit 1; fi
    trap - EXIT
    sed -i "s|hash = \"\";|hash = \"$new\";|" flake.nix
    if [ "$new" = "$old" ]; then
        echo "pnpmDeps.hash already up to date: $new"
    else
        echo "pnpmDeps.hash: $old -> $new"
    fi

[private]
alias bh := bump-hash

# updates dependency versions aggressively. It can fail.
update:
    pnpm dlx npm-check-updates -u && pnpm install && just bump-hash

# creates a new electron-vite project. This is just a note.
[private]
create:
    pnpm create @quick-start/electron@latest
