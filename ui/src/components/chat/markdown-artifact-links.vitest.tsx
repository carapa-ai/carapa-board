import { fireEvent, render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from '@/components/markdown-content';
import { useStore } from '@/store';

afterEach(() => {
  cleanup();
  useStore.setState({
    previewTabsByProject: {},
    pendingPreviewActivationByProject: {},
  });
});

describe('chat Markdown artifact links', () => {
  it('opens a same-project artifact through the preview-tab store and keeps href', () => {
    const onOpenArtifact = (path: string) => {
      useStore.getState().openPreviewTab('carapa-board', {
        id: `group:${path}`,
        title: path.split('/').at(-1) ?? 'artifact',
        kind: 'file',
        source: 'group',
        path,
      });
    };
    render(
      <MarkdownContent
        projectFolder="carapa-board"
        onOpenArtifact={onOpenArtifact}
      >
        {'[Report](/artifacts/carapa-board/reports/review.md?version=2)'}
      </MarkdownContent>,
    );
    const link = document.querySelector('a');
    expect(link?.getAttribute('href')).toBe(
      '/artifacts/carapa-board/reports/review.md?version=2',
    );
    fireEvent.click(link!);
    fireEvent.click(link!);
    const preview = useStore.getState().previewTabsByProject['carapa-board'];
    expect(preview?.tabs).toHaveLength(1);
    expect(preview?.activeTabId).toBe('group:artifacts/reports/review.md');
  });

  it.each([
    ['/workspace/3d-box/Dockerfile', 'repo', 'Dockerfile'],
    [
      '/workspace/group/3d-box-deploy/LIBRARY-INITIALIZATION.md',
      'group',
      '3d-box-deploy/LIBRARY-INITIALIZATION.md',
    ],
    ['./deploy/build.sh', 'repo', 'deploy/build.sh'],
    ['Dockerfile', 'repo', 'Dockerfile'],
    ['group/notes/report.md', 'group', 'notes/report.md'],
    ['artifacts/reports/review.md', 'group', 'artifacts/reports/review.md'],
    ['/workspace/src/main.ts:12:3', 'repo', 'src/main.ts'],
    [
      '/workspace/group/notes/my%20report.md#summary',
      'group',
      'notes/my report.md',
    ],
  ])('opens file reference %s in its Files source', (href, source, path) => {
    const onOpenArtifact = vi.fn();
    render(
      <MarkdownContent
        projectFolder="3d-box"
        onOpenArtifact={onOpenArtifact}
      >{`[File](${href})`}</MarkdownContent>,
    );
    const link = document.querySelector('a')!;
    expect(fireEvent.click(link)).toBe(false);
    expect(onOpenArtifact).toHaveBeenCalledWith(path, undefined, source);
    expect(link.getAttribute('href')).toBe(href);
  });

  it('leaves excluded links as ordinary anchors', () => {
    const onOpenArtifact = vi.fn();
    render(
      <MarkdownContent
        projectFolder="carapa-board"
        onOpenArtifact={onOpenArtifact}
      >
        {
          '[cross](/artifacts/other-project/report.md) [bad](/artifacts/carapa-board/../secret.md) [nested](/artifacts/carapa-board/reports/../secret.md) [encoded-dot](/artifacts/carapa-board/reports/%2e%2e/secret.md) [encoded](/artifacts/carapa-board/reports%2F..%2Fsecret.md) [backslash](https://localhost\\unrelated/artifacts/carapa-board/report.md) [relative-bad](../secret.md) [encoded-relative](docs/%2e%2e/secret.md) [anchor](#summary) [query](?view=files) [mail](mailto:user@example.com) [app](/board/carapa-board) [external](https://example.com) [sandbox-bad](/workspace/group/artifacts/../secret.md) [sandbox-nested](/workspace/group/artifacts/reports/../secret.md) [sandbox-encoded](/workspace/group/artifacts/reports/%2e%2e/secret.md) [sandbox-external](https://example.com/workspace/group/artifacts/report.md)'
        }
      </MarkdownContent>,
    );
    const links = [...document.querySelectorAll('a')];
    for (const link of links) fireEvent.click(link);
    expect(onOpenArtifact).not.toHaveBeenCalled();
    expect(links.every((link) => link.getAttribute('href'))).toBe(true);
  });
});
