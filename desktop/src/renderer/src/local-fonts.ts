// Installed-font enumeration for the font picker, via the Local Font Access
// API (Chromium's `queryLocalFonts`; Electron grants the 'local-fonts'
// permission check by default, no gesture needed). Browser-only on purpose —
// the renderer never touches Node (CLAUDE.md "Process boundaries"), so no
// fontconfig/IPC detour.

/** The CSS generic families the picker always offers, even when enumeration fails. */
export const GENERIC_FONT_FAMILIES = ['serif', 'sans-serif', 'monospace'] as const;

/**
 * The editor's preferred default fonts, best first — all gothic (角ゴシック)
 * for a clean on-screen default. All are FULL CJK faces so they own the shared
 * punctuation (…、。「」): a CJK glyph is fullwidth and em-centered, so it sits
 * centered in a vertical column, whereas a Latin fallback's glyph hugs one edge
 * (the reason `inherit`, a Latin-only shell stack, renders an off-centre `…`).
 * Localized names are listed alongside their English aliases because
 * {@link localFontFamilies} reports whichever the OS uses.
 */
export const PREFERRED_DEFAULT_FONTS = [
  'Noto Sans CJK JP',
  'Noto Sans JP', // webfont packaging drops the "CJK"
  'Source Han Sans JP', // Adobe's name for the same face
  'Hiragino Kaku Gothic ProN', // macOS
  'YuGothic',
  'Yu Gothic',
  '游ゴシック', // Windows / macOS
  'BIZ UDGothic', // Windows
  'IPAexGothic',
  'Meiryo', // Windows
] as const;

/**
 * A blind CJK-first stack used only when enumeration is unavailable (the Local
 * Font Access API missing or denied, so `installed` is empty). Still beats the
 * Latin shell `inherit`: it at least NAMES CJK faces before the generic, so a
 * present-but-unenumerable Noto/Hiragino/Yu wins the punctuation.
 */
export const FALLBACK_DEFAULT_STACK = '"Noto Sans CJK JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';

/**
 * The default editor font, resolved against the installed set: the first
 * {@link PREFERRED_DEFAULT_FONTS} entry present wins. Returns
 * {@link FALLBACK_DEFAULT_STACK} when enumeration yielded nothing (API absent),
 * and '' (→ inherit; nothing better exists) when it enumerated but found no CJK
 * face.
 */
export const pickDefaultFont = (installed: readonly string[]): string => {
  const present = new Set(installed);
  const hit = PREFERRED_DEFAULT_FONTS.find((family) => present.has(family));
  if (hit !== undefined) return hit;
  return installed.length === 0 ? FALLBACK_DEFAULT_STACK : '';
};

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
