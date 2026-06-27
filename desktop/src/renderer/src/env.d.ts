/// <reference types="vite/client" />

declare module '*.module.scss' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Side-effect asset imports (incl. @ved/editor's source, re-checked here under
// source consumption): the editor imports `*.css`, the shell imports `*.scss`.
declare module '*.scss';
declare module '*.css';
