// The preview re-exports the pure view-config contract from @ved/editor
// (no store — plain state in app.tsx; this site is a throwaway).
export {
  clampViewConfig,
  VIEW_CONFIG_BOUNDS,
  VIEW_CONFIG_DEFAULTS,
  type ViewConfig,
  viewConfigFromPersisted,
  viewConfigToCss,
} from '@ved/editor';
