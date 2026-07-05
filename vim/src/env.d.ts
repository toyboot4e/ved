// @ved/editor is consumed as SOURCE (its exports entry is raw TS), so its
// asset imports are re-checked under this package's tsconfig — declare the
// same shapes desktop/web do.
declare module '*.module.scss' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.css';
