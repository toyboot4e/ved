import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from './workspace';

const s = () => useWorkspaceStore.getState();

describe('useWorkspaceStore', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      roots: [],
      sidebarOpen: false,
      sidebarSide: 'left',
      sidebarWidth: 240,
      sidebarView: 'files',
    });
  });

  it('adds roots in order without duplicates', () => {
    s().addRoot('/a');
    s().addRoot('/b');
    s().addRoot('/a');
    expect(s().roots).toEqual(['/a', '/b']);
  });

  it('removes only the named root', () => {
    s().addRoot('/a');
    s().addRoot('/b');
    s().removeRoot('/a');
    expect(s().roots).toEqual(['/b']);
  });

  it('clamps the dragged width to sane bounds', () => {
    s().setSidebarWidth(300.6);
    expect(s().sidebarWidth).toBe(301);
    s().setSidebarWidth(20);
    expect(s().sidebarWidth).toBe(160);
    s().setSidebarWidth(9000);
    expect(s().sidebarWidth).toBe(480);
  });

  it('switches the pane view between the trees and the open buffers', () => {
    expect(s().sidebarView).toBe('files');
    s().setSidebarView('buffers');
    expect(s().sidebarView).toBe('buffers');
    s().setSidebarView('files');
    expect(s().sidebarView).toBe('files');
  });

  it('toggles visibility and flips the docked side', () => {
    s().toggleSidebar();
    expect(s().sidebarOpen).toBe(true);
    s().flipSidebarSide();
    expect(s().sidebarSide).toBe('right');
    s().flipSidebarSide();
    expect(s().sidebarSide).toBe('left');
  });
});
