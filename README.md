# ved

[WIP] Vertical editor for novel writers backed by plaintext.

## Quick start

If you're using Nix:

```sh
nix run github:toyboot4e/ved
```

## Development

If you're using Nix, run `direnv allow`.

`pnpm` is the primary build tool:

```sh
pnpm install   # also downloads the Electron binary (project postinstall)
pnpm run dev
```

See [./Justfile](./Justfile) for more commands.

## Documents

See [docs/architecture.md](docs/architecture.md) for the design.

## Thanks

- [electron](https://github.com/electron/electron)
- [electron-vite](https://electron-vite.github.io/)
- [ProseMirror](https://code.haverbeke.berlin/prosemirror/prosemirror)

