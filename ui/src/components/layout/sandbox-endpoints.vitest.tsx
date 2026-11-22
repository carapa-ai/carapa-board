import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SandboxInstance } from '@/lib/api';
import {
  SandboxServicePorts,
  SandboxWorktreePreview,
} from './sandbox-endpoints';

test('migrated services expose their reserved HTTP endpoints without broken browser links or duplicate SSH ports', () => {
  const instance: SandboxInstance = {
    name: 'demo-site-demo-site',
    services: [
      {
        service: 'nginx',
        hostname: 'demo-site-nginx-1',
        status: 'running',
        ports: [],
      },
      {
        service: 'php84',
        hostname: 'demo-site-php84-1',
        status: 'running',
        ports: ['9999->3100/tcp'],
      },
    ],
    ingress: [
      {
        service: 'nginx',
        targetPort: 80,
        kind: 'http',
        host: '192.168.1.10',
        port: 22073,
      },
      {
        service: 'php84',
        targetPort: 3100,
        kind: 'http',
        host: '192.168.1.10',
        port: 22155,
      },
      {
        service: 'php84',
        targetPort: 2222,
        kind: 'ssh',
        host: '192.168.1.10',
        port: 22238,
      },
    ],
  };
  const document = new DOMParser().parseFromString(
    renderToStaticMarkup(
      <>
        {instance.services.map((service) => (
          <SandboxServicePorts
            key={service.service}
            instance={instance}
            service={service}
          />
        ))}
      </>,
    ),
    'text/html',
  );
  const nginx = document.querySelector('[data-service="nginx"]')!;
  expect(nginx.textContent).toContain('192.168.1.10:22073');
  expect(nginx.textContent).toContain('→ 80');
  const php = document.querySelector('[data-service="php84"]')!;
  expect(php.textContent).toContain('192.168.1.10:22155');
  expect(php.textContent).not.toContain('22073');
  expect(php.textContent).not.toContain('22238');
  expect(php.textContent).not.toContain('9999');
  expect(document.querySelectorAll('a').length).toBe(0);
});

test('legacy published ports remain usable and internal worktree previews are copyable HTTP addresses', () => {
  const instance: SandboxInstance = {
    name: 'legacy',
    services: [
      {
        service: 'nginx',
        hostname: 'legacy-nginx-1',
        status: 'running',
        ports: ['0.0.0.0:7080->80/tcp', '[::]:7080->80/tcp'],
      },
    ],
  };
  const document = new DOMParser().parseFromString(
    renderToStaticMarkup(
      <>
        <SandboxServicePorts
          instance={instance}
          service={instance.services[0]}
        />
        <SandboxWorktreePreview
          worktree={{ slug: 'feature/editor', port: 8082 }}
        />
      </>,
    ),
    'text/html',
  );
  expect(
    Array.from(document.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    ),
  ).toEqual(['http://localhost:7080']);
  const preview = document.querySelector('[data-worktree="feature/editor"]')!;
  expect(preview.querySelector('button')?.textContent).toContain(
    'http://nginx:8082/',
  );
  expect(preview.textContent).toContain('Sandbox only');
  expect(preview.querySelector('a')).toBeNull();
});
