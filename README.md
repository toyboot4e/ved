# ved

WIP

Developed with [electron-vite](https://electron-vite.github.io/).

## Quick start

If you're using Nix:

```sh
nix run github:toyboot4e/ved
```

## Development

```sh
nix develop    # or `direnv allow` — Electron runtime libs, pnpm, biome
pnpm install   # also downloads the Electron binary (project postinstall)
pnpm run dev
```

See [docs/architecture.md](docs/architecture.md) for the design.
