# Just a task runner
# <https://github.com/casey/just>

# shows this help message
help:
    @just -l

# Runs biome check --fix
c:
  pnpm run check:fix

# Runs biome check --fix ignoring errors
cf:
  pnpm run check:fix --format-with-errors true --diagnostic-level error

# Starts development server
dev:
  pnpm run dev

alias d := dev

# Updates dependency versions aggressively. It can fail.
update:
  pnpm dlx npm-check-updates -u && pnpm install

# Creates a new electron-vite project. This is just a note.
create:
  pnpm create @quick-start/electron@latest
