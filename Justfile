# Just a task runner:
# https://github.com/casey/just

# shows this help message
help:
    @just -l

# runs everything locally
all:
    nix flake check
    just smoke

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

# starts the development server (HMR)
dev:
    pnpm run dev

[private]
alias d := dev

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

# runs the end-to-end smoke test against the built app
smoke: build
    pnpm run smoke

[private]
alias s := smoke

# runs unit tests (parameter example: 'cursor-map')
test *args:
    pnpm run test {{args}}

[private]
alias t := test

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

# updates dependency versions aggressively. It can fail.
update:
    pnpm dlx npm-check-updates -u && pnpm install

# creates a new electron-vite project. This is just a note.
[private]
create:
    pnpm create @quick-start/electron@latest
