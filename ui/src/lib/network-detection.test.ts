// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  NetworkProbeCoordinator,
  getLastProbeResult,
  applyConnectionModeChange,
  holdConnectionMode,
  isConnectionModeHeld,
  isLocalHostname,
  onConnectionModeHoldReleased,
} from './network-detection';

describe('local hostname classification', () => {
  test('recognizes runtime-provided LAN aliases without compile-time env', () => {
    const runtimeHosts = new Set(['board.home.test']);

    expect(
      isLocalHostname('board.home.test', runtimeHosts, '192.168.50.10'),
    ).toBe(true);
    expect(
      isLocalHostname('board.remote.test', runtimeHosts, '192.168.50.10'),
    ).toBe(false);
  });

  test('retains built-in loopback, private-IP, and local-domain handling', () => {
    const noConfiguredHosts = new Set<string>();

    expect(
      isLocalHostname('localhost', noConfiguredHosts, '192.168.50.10'),
    ).toBe(true);
    expect(
      isLocalHostname('192.168.50.25', noConfiguredHosts, '192.168.50.10'),
    ).toBe(true);
    expect(
      isLocalHostname('board.local', noConfiguredHosts, '192.168.50.10'),
    ).toBe(true);
  });
});

describe('NetworkProbeCoordinator', () => {
  test('reconnects realtime once when a mode transition changes origin', () => {
    const modes: string[] = [];
    let reconnects = 0;
    const changed = applyConnectionModeChange(
      'home',
      'remote',
      (mode) =>
        mode === 'home'
          ? 'https://192.168.50.10:3000'
          : 'https://board.example.test',
      (mode) => modes.push(mode),
      () => {
        reconnects += 1;
      },
    );

    expect(changed).toBe(true);
    expect(modes).toEqual(['remote']);
    expect(reconnects).toBe(1);
  });

  test('does not reconnect for an unchanged mode or shared origin', () => {
    let modeChanges = 0;
    let reconnects = 0;
    const setMode = () => {
      modeChanges += 1;
    };
    const reconnect = () => {
      reconnects += 1;
    };

    expect(
      applyConnectionModeChange(
        'home',
        'home',
        () => 'https://board.example.test',
        setMode,
        reconnect,
      ),
    ).toBe(false);
    expect(
      applyConnectionModeChange(
        'home',
        'remote',
        () => 'https://board.example.test',
        setMode,
        reconnect,
      ),
    ).toBe(true);
    expect(modeChanges).toBe(1);
    expect(reconnects).toBe(0);
  });

  test('serializes overlapping probes', async () => {
    let resolveProbe!: (reachable: boolean) => void;
    let calls = 0;
    const probe = new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });
    const detector = new NetworkProbeCoordinator(
      () => {
        calls += 1;
        return probe;
      },
      () => {},
    );

    const first = detector.check();
    const second = detector.check();
    expect(calls).toBe(1);
    expect(second).toBe(first);
    resolveProbe(true);
    await first;
  });

  test('requires consecutive failures and recovers immediately', async () => {
    const results = [false, true, false, false];
    const modes: string[] = [];
    const detector = new NetworkProbeCoordinator(
      async () => results.shift() ?? true,
      (mode) => modes.push(mode),
      2,
    );

    await detector.check();
    expect(modes).toEqual([]);
    await detector.check();
    expect(modes).toEqual(['home']);
    await detector.check();
    expect(modes).toEqual(['home']);
    await detector.check();
    expect(modes).toEqual(['home', 'remote']);
  });

  test('records the last probe result with the failure reason', async () => {
    const detector = new NetworkProbeCoordinator(
      async () => {
        throw new Error('SSL handshake failed');
      },
      () => {},
    );

    await detector.check();
    expect(getLastProbeResult()).toMatchObject({
      ok: false,
      message: 'SSL handshake failed',
    });
  });

  test('ignores a probe result after stop', async () => {
    let resolveProbe!: (reachable: boolean) => void;
    const modes: string[] = [];
    const detector = new NetworkProbeCoordinator(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
      (mode) => modes.push(mode),
    );

    const check = detector.check();
    detector.stop();
    resolveProbe(true);
    await check;
    expect(modes).toEqual([]);
  });

  test('holds mode changes through nested long-running operations', () => {
    let releases = 0;
    const unsubscribe = onConnectionModeHoldReleased(() => {
      releases += 1;
    });
    const releaseFirst = holdConnectionMode();
    const releaseSecond = holdConnectionMode();

    expect(isConnectionModeHeld()).toBe(true);
    releaseFirst();
    expect(isConnectionModeHeld()).toBe(true);
    expect(releases).toBe(0);
    releaseSecond();
    expect(isConnectionModeHeld()).toBe(false);
    expect(releases).toBe(1);

    releaseSecond();
    expect(releases).toBe(1);
    unsubscribe();
  });
});
