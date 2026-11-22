// @ts-nocheck
import { afterEach, describe, expect, it } from 'bun:test';
import {
  canLeaveActivePreview,
  registerPreviewTabLeaveGuard,
  useStore,
} from './store';

const projectId = 'preview-guard-project';
const one = {
  id: 'one',
  title: 'one.md',
  kind: 'file',
  source: 'group',
  path: 'one.md',
};
const two = {
  id: 'two',
  title: 'two.md',
  kind: 'file',
  source: 'group',
  path: 'two.md',
};

afterEach(() =>
  useStore.setState({ previewTabsByProject: {}, workspaceViewByProject: {} }),
);

const seed = () =>
  useStore.setState({
    previewTabsByProject: {
      [projectId]: {
        tabs: [one, two],
        activeTabId: one.id,
        activationSequence: 0,
      },
    },
  });
const tabState = () => useStore.getState().previewTabsByProject[projectId];

describe('preview tab leave guards', () => {
  it('blocks external open/activate/close actions until the dirty editor allows leaving', async () => {
    seed();
    let allow = false;
    const unregister = registerPreviewTabLeaveGuard(
      projectId,
      one.id,
      () => allow,
    );
    expect(await canLeaveActivePreview(projectId)).toBe(false);

    await useStore.getState().setActivePreviewTab(projectId, two.id);
    expect(tabState().activeTabId).toBe(one.id);
    await useStore
      .getState()
      .openPreviewTab(projectId, { ...two, id: 'three', path: 'three.md' });
    expect(tabState().tabs.map((tab) => tab.id)).toEqual(['one', 'two']);
    await useStore.getState().closePreviewTab(projectId, one.id);
    expect(tabState().tabs.map((tab) => tab.id)).toEqual(['one', 'two']);

    allow = true;
    expect(await canLeaveActivePreview(projectId)).toBe(true);
    await useStore.getState().setActivePreviewTab(projectId, two.id);
    expect(tabState().activeTabId).toBe(two.id);
    unregister();
  });

  it('waits for an asynchronous guard before changing tabs', async () => {
    seed();
    let decide: (allowed: boolean) => void = () => {};
    let prompts = 0;
    const unregister = registerPreviewTabLeaveGuard(projectId, one.id, () => {
      prompts += 1;
      return new Promise<boolean>((resolve) => {
        decide = resolve;
      });
    });

    // Declined: nothing changes.
    const declined = useStore.getState().setActivePreviewTab(projectId, two.id);
    expect(tabState().activeTabId).toBe(one.id);
    decide(false);
    expect(await declined).toBe(false);
    expect(tabState().activeTabId).toBe(one.id);

    // Repeated gestures while a prompt is open share it; accepting applies once.
    const first = useStore.getState().closePreviewTab(projectId, one.id);
    const second = useStore.getState().closePreviewTab(projectId, one.id);
    expect(prompts).toBe(2);
    decide(true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(tabState().tabs.map((tab) => tab.id)).toEqual(['two']);
    expect(tabState().activeTabId).toBe(two.id);
    unregister();
  });

  it('closes without asking again when the guard was already checked', async () => {
    seed();
    let prompts = 0;
    const unregister = registerPreviewTabLeaveGuard(projectId, one.id, () => {
      prompts += 1;
      return Promise.resolve(false);
    });
    expect(
      await useStore.getState().closePreviewTab(projectId, one.id, true),
    ).toBe(true);
    expect(prompts).toBe(0);
    expect(tabState().tabs.map((tab) => tab.id)).toEqual(['two']);
    unregister();
  });
});
