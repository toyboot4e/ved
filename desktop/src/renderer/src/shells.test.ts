import { beforeEach, describe, expect, it } from 'vitest';
import { useShellStore } from './shells';

const s = () => useShellStore.getState();

describe('useShellStore', () => {
  beforeEach(() => {
    useShellStore.setState({ open: false, tabs: [], activePtyId: null });
  });

  it('adding a tab activates it and opens the panel', () => {
    s().addTab({ ptyId: 1, title: 'a' });
    s().addTab({ ptyId: 2, title: 'b' });
    expect(s().open).toBe(true);
    expect(s().tabs.map((t) => t.ptyId)).toEqual([1, 2]);
    expect(s().activePtyId).toBe(2);
  });

  it('removing the active tab falls onto the right neighbor, then the last', () => {
    s().addTab({ ptyId: 1, title: 'a' });
    s().addTab({ ptyId: 2, title: 'b' });
    s().addTab({ ptyId: 3, title: 'c' });
    s().setActive(2);
    s().removeTab(2);
    expect(s().activePtyId).toBe(3);
    s().removeTab(3);
    expect(s().activePtyId).toBe(1);
  });

  it('removing an inactive tab keeps the active one', () => {
    s().addTab({ ptyId: 1, title: 'a' });
    s().addTab({ ptyId: 2, title: 'b' });
    s().removeTab(1);
    expect(s().activePtyId).toBe(2);
  });

  it('removing the last tab closes the panel', () => {
    s().addTab({ ptyId: 1, title: 'a' });
    s().removeTab(1);
    expect(s().open).toBe(false);
    expect(s().tabs).toEqual([]);
    expect(s().activePtyId).toBeNull();
  });

  it('toggle flips the panel without touching the tabs', () => {
    s().addTab({ ptyId: 1, title: 'a' });
    s().toggle();
    expect(s().open).toBe(false);
    expect(s().tabs.length).toBe(1);
    s().toggle();
    expect(s().open).toBe(true);
  });

  it('setActive ignores unknown ids', () => {
    s().addTab({ ptyId: 1, title: 'a' });
    s().setActive(99);
    expect(s().activePtyId).toBe(1);
  });
});
