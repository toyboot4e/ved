// Vite import queries used by the main process. `?asset` comes typed by
// electron-vite/node; `?raw` (vite core: the file's text at build time) does
// not, so it is declared here — extension-host.ts inlines the extension-api
// source as the generated ved.d.ts.
declare module '*?raw' {
  const source: string;
  export default source;
}
