import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { push, getMatchedRoutes } = vi.hoisted(() => ({
  push: vi.fn(),
  getMatchedRoutes: vi.fn(),
}));

vi.mock('@/lib/router', () => ({
  router: {
    history: { push },
    getMatchedRoutes,
  },
}));

import { MarkdownAppLinkContext, MarkdownContent } from './markdown-content';

/** Click an anchor the way a browser does and report the native event. */
function click(link: HTMLElement, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  link.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  push.mockReset();
  getMatchedRoutes.mockReset();
  getMatchedRoutes.mockImplementation((pathname: string) => ({
    matchedRoutes: [],
    routeParams: {},
    parsedParams: undefined,
    foundRoute: pathname.startsWith('/objective/')
      ? { id: '/objective/$projectId/$objectiveId' }
      : undefined,
  }));
});

describe('MarkdownContent in-app links', () => {
  it('navigates to an app route without a page reload', async () => {
    render(
      <MarkdownContent>
        {'[report](/objective/carapa/obj-1?report=x.md)'}
      </MarkdownContent>,
    );

    const link = screen.getByRole('link', { name: 'report' });
    const event = click(link);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(push).toHaveBeenCalledWith(
      '/objective/carapa/obj-1?report=x.md',
      undefined,
      { ignoreBlocker: false },
    );
  });

  it('leaves modifier clicks to the browser', async () => {
    render(
      <MarkdownContent>{'[report](/objective/carapa/obj-1)'}</MarkdownContent>,
    );

    const link = screen.getByRole('link', { name: 'report' });
    const event = click(link, { ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
  });

  it('leaves external links to the browser', async () => {
    render(
      <MarkdownContent>
        {'[other](https://other.example/objective/x)'}
      </MarkdownContent>,
    );

    const link = screen.getByRole('link', { name: 'other' });
    const event = click(link);

    expect(event.defaultPrevented).toBe(false);
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps opening project file links in place', async () => {
    const onOpenArtifact = vi.fn();
    render(
      <MarkdownContent projectFolder="carapa" onOpenArtifact={onOpenArtifact}>
        {'[file](artifacts/notes.md)'}
      </MarkdownContent>,
    );

    const link = screen.getByRole('link', { name: 'file' });
    const event = click(link);

    expect(event.defaultPrevented).toBe(true);
    expect(onOpenArtifact).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
  });

  it('reports the activation of an app link to the provider', async () => {
    const onAppLink = vi.fn();
    render(
      <MarkdownAppLinkContext.Provider value={onAppLink}>
        <MarkdownContent>
          {'[report](/objective/carapa/obj-1?report=x.md)'}
        </MarkdownContent>
      </MarkdownAppLinkContext.Provider>,
    );

    const link = screen.getByRole('link', { name: 'report' });
    click(link);

    expect(onAppLink).toHaveBeenCalledWith(
      '/objective/carapa/obj-1?report=x.md',
    );
  });

  it('waits for the provider and navigates when it allows the activation', async () => {
    const onAppLink = vi.fn(async () => true);
    render(
      <MarkdownAppLinkContext.Provider value={onAppLink}>
        <MarkdownContent>
          {'[report](/objective/carapa/obj-1?report=x.md)'}
        </MarkdownContent>
      </MarkdownAppLinkContext.Provider>,
    );

    const link = screen.getByRole('link', { name: 'report' });
    click(link);

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    // The provider already asked whether the active preview may be left, so
    // the router's blocker must not ask a second time.
    expect(push).toHaveBeenCalledWith(
      '/objective/carapa/obj-1?report=x.md',
      undefined,
      { ignoreBlocker: true },
    );
  });

  it('does not navigate when the provider vetoes the activation', async () => {
    const onAppLink = vi.fn(async () => false);
    render(
      <MarkdownAppLinkContext.Provider value={onAppLink}>
        <MarkdownContent>
          {'[report](/objective/carapa/obj-1?report=x.md)'}
        </MarkdownContent>
      </MarkdownAppLinkContext.Provider>,
    );

    const link = screen.getByRole('link', { name: 'report' });
    const event = click(link);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(onAppLink).toHaveBeenCalled());
    // Let the provider's decision settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(push).not.toHaveBeenCalled();
  });
});
