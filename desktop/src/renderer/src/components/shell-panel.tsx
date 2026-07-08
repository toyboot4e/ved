// Integrated shell panel (bottom of the editor column): one xterm per tab,
// each attached to a main-process PTY (shell-service.ts) over the streaming
// half of the `window.ved` contract. The PANEL stays mounted while toggled
// closed (CSS hidden) so shells and scrollback survive Ctrl+` round-trips;
// terminals die only when their PTY exits or their tab is closed.
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { clsx } from 'clsx';
import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { type ShellTab, useShellStore } from '../shells';
import { useThemeStore } from '../theme';
import styles from './shell-panel.module.scss';
import { shellTheme } from './shell-theme';

export type ShellPanelProps = {
  /** Directory for NEW shells: the active file's directory when there is one. */
  readonly defaultCwd: string | undefined;
};

// Live terminals by PTY id — outside React so the e2e seam can read a
// buffer without threading refs through the tree.
const terminals = new Map<number, Terminal>();

// Recolor live terminals on a palette flip. theme.ts is a dependency of this
// module, so its own subscriber — the one that writes `data-theme` on <html> —
// registered first and has already run: shellTheme() reads the NEW tokens.
useThemeStore.subscribe(() => {
  for (const term of terminals.values()) term.options.theme = shellTheme();
});

/** e2e seam: the active terminal's screen+scrollback as plain text. */
const shellText = (ptyId: number | null): string => {
  const term = ptyId === null ? undefined : terminals.get(ptyId);
  if (!term) return '';
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
};

const ShellTerminal = ({
  ptyId,
  visible,
}: {
  readonly ptyId: number;
  /** Panel open AND this tab active: fit + focus follow this. */
  readonly visible: boolean;
}): React.JSX.Element => {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 2000, theme: shellTheme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    terminals.set(ptyId, term);
    fitRef.current = fit;

    const offData = window.ved.onShellData((id, data) => {
      if (id === ptyId) term.write(data);
    });
    const input = term.onData((data) => window.ved.writeShell(ptyId, data));
    const resize = term.onResize(({ cols, rows }) => window.ved.resizeShell(ptyId, cols, rows));
    fit.fit();
    // Listeners are wired — let the paused PTY flow (see VedShellApi)
    window.ved.resumeShell(ptyId);

    return () => {
      offData();
      input.dispose();
      resize.dispose();
      terminals.delete(ptyId);
      term.dispose();
    };
  }, [ptyId]);

  useEffect(() => {
    if (!visible) return;
    // Synchronously, NOT via requestAnimationFrame: effects run after the DOM
    // update that made the host visible (measurable), and rAF can stall for
    // seconds in a hidden window (e2e) — the focus would land after the test
    // typed into nothing.
    fitRef.current?.fit();
    terminals.get(ptyId)?.focus();
  }, [visible, ptyId]);

  return <div ref={hostRef} className={styles.term} data-active={visible} />;
};

export const ShellPanel = ({ defaultCwd }: ShellPanelProps): React.JSX.Element | null => {
  const open = useShellStore((s) => s.open);
  const tabs = useShellStore((s) => s.tabs);
  const activePtyId = useShellStore((s) => s.activePtyId);

  const handleNewShell = useCallback(async (): Promise<void> => {
    const ptyId = await window.ved.createShell(defaultCwd);
    useShellStore.getState().addTab({ ptyId, title: 'shell' });
  }, [defaultCwd]);

  // Opening the panel with no tabs spawns the first shell (also when the last
  // tab dies while open); `creating` guards the async gap between the spawn
  // starting and its tab landing in the store.
  const creating = useRef(false);
  useEffect(() => {
    if (!open || tabs.length > 0 || creating.current) return;
    creating.current = true;
    void handleNewShell().finally(() => {
      creating.current = false;
    });
  }, [open, tabs.length, handleNewShell]);

  // A PTY exit (user typed `exit`, shell crashed) drops its tab
  useEffect(() => window.ved.onShellExit((id) => useShellStore.getState().removeTab(id)), []);

  // e2e seam
  useEffect(() => {
    (window as unknown as { __vedShellText: () => string }).__vedShellText = () =>
      shellText(useShellStore.getState().activePtyId);
  }, []);

  const handleClose = (ptyId: number): void => {
    window.ved.killShell(ptyId);
    useShellStore.getState().removeTab(ptyId);
  };

  if (tabs.length === 0) return null;
  return (
    <section className={styles.shellPanel} aria-label='Shell panel' data-open={open}>
      <div className={styles.shellTabs} role='tablist'>
        {tabs.map((tab: ShellTab, i) => (
          <div
            key={tab.ptyId}
            role='tab'
            tabIndex={tab.ptyId === activePtyId ? 0 : -1}
            aria-selected={tab.ptyId === activePtyId}
            className={clsx(styles.shellTab, tab.ptyId === activePtyId && styles.active)}
            onMouseDown={(e) => {
              if (e.button === 0) useShellStore.getState().setActive(tab.ptyId);
            }}
          >
            <span className={styles.shellTabLabel}>
              {i + 1}: {tab.title}
            </span>
            <button
              type='button'
              className={styles.iconButton}
              aria-label={`Close shell ${i + 1}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => handleClose(tab.ptyId)}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type='button'
          className={styles.iconButton}
          aria-label='New shell'
          title='新しいシェル'
          onClick={() => void handleNewShell()}
        >
          ＋
        </button>
      </div>
      <div className={styles.shellBody}>
        {tabs.map((tab) => (
          <ShellTerminal key={tab.ptyId} ptyId={tab.ptyId} visible={open && tab.ptyId === activePtyId} />
        ))}
      </div>
    </section>
  );
};
