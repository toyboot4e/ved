// Installed-font enumeration for the font picker, via the Local Font Access
// API (Chromium's `queryLocalFonts`; Electron grants the 'local-fonts'
// permission check by default, no gesture needed). Browser-only on purpose —
// the renderer never touches Node (CLAUDE.md "Process boundaries"), so no
// fontconfig/IPC detour.

/** The CSS generic families the picker always offers, even when enumeration fails. */
export const GENERIC_FONT_FAMILIES = ['serif', 'sans-serif', 'monospace'] as const;

type LocalFontData = { readonly family: string };
type QueryLocalFonts = () => Promise<readonly LocalFontData[]>;

/**
 * The installed font families, deduplicated and locale-sorted. Empty when the
 * API is missing or throws (old Chromium, denied permission) — the picker then
 * degrades to {@link GENERIC_FONT_FAMILIES} only.
 */
export const localFontFamilies = async (): Promise<readonly string[]> => {
  const query = (window as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (query === undefined) return [];
  try {
    const fonts = await query.call(window);
    return [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
};
