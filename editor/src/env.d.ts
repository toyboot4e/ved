// The editor core has no bundler dep of its own (consumers' Vite handles the
// real transforms), so declare the asset-import shapes here for typecheck.
declare module '*.module.scss' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.css';
