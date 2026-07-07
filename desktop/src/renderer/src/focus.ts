// Focus discipline for the app chrome: focus belongs to the editor (or to an
// open bar/overlay's input), and chrome clicks must never steal it.
import type React from 'react';

/** `onMouseDown` for chrome buttons: `preventDefault()` stops the browser's
 *  focus transfer, so a click keeps focus (and the selection) where it is —
 *  in the editor for toolbar/sidebar/tab-bar clicks, in the bar's or
 *  overlay's own input for search / quick-open buttons. */
export const preserveFocus: React.MouseEventHandler = (event) => {
  event.preventDefault();
};

/** Hands focus (back) to the editor's contenteditable — THE home of the
 *  `editor-content` element id. Closing the search bar or the quick-open
 *  overlay (whose inputs own focus while open) routes through this. */
export const focusEditor = (): void => {
  document.getElementById('editor-content')?.focus();
};
