# Just a task runner
# <https://github.com/casey/just>

# shows this help message
help:
    @just -l

# Runs biome check --fix
c:
  npm run check:fix

# Runs biome check --fix ignoring errors
cf:
  npm run check:fix -- --format-with-errors true

# Updates dependency versions aggressively. It can fail.
update:
  npx npm-check-updates -u && npm install

# Creates a new electron-vite project. This is just a note.
create:
  npm create @quick-start/electron@latest

