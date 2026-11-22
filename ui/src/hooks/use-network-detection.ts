import { useEffect, useRef } from 'react';
import { useStore } from '@/store';
import {
  LOCAL_IP,
  apiBaseUrlForMode,
  updateApiBaseUrl,
} from '@/lib/api-config';
import { useServerUrls } from '@/hooks/use-server-urls';
import { queryClient } from '@/lib/query-client';
import { connectWebSocket } from '@/lib/websocket';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { fetchNetworkConfig } from '@/lib/api';
import {
  type ConnectionMode,
  NetworkProbeCoordinator,
  applyConnectionModeChange,
  isConnectionModeHeld,
  isLocalHostname,
  onConnectionModeHoldReleased,
} from '@/lib/network-detection';

const configuredLocalHosts = new Set(
  String(import.meta.env.VITE_LOCAL_HOSTNAMES || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

/** Build-time plus runtime (server-reported) local hostnames. */
async function loadLocalHostnames(): Promise<Set<string>> {
  const localHosts = new Set(configuredLocalHosts);
  try {
    const config = await fetchNetworkConfig();
    for (const hostname of config.localHostnames) {
      const normalized = hostname.trim().toLowerCase();
      if (normalized) localHosts.add(normalized);
    }
  } catch (error) {
    console.warn(
      '[NetworkDetection] Could not load runtime network config:',
      error,
    );
  }
  return localHosts;
}

/** Classify the web page's own hostname with the runtime local-hostname list. */
export async function detectWebConnectionMode(): Promise<ConnectionMode> {
  const localHosts = await loadLocalHostnames();
  return isLocalHostname(window.location.hostname, localHosts, LOCAL_IP)
    ? 'home'
    : 'remote';
}

/**
 * Switch the connection mode (detector or manual pick): update store and API
 * base URL, and force a WebSocket reconnect when the origin changes.
 */
export function switchConnectionMode(newMode: ConnectionMode) {
  const state = useStore.getState();
  applyConnectionModeChange(
    state.connectionMode,
    newMode,
    apiBaseUrlForMode,
    (mode) => {
      state.setConnectionMode(mode);
      updateApiBaseUrl(mode);
    },
    () => {
      connectWebSocket(queryClient, { force: true });
    },
  );
}

// Wi-Fi is often not routable yet when the connectivity event fires.
const NETWORK_CHANGE_PROBE_DELAYS_MS = [1000, 3000, 8000];

export function useNetworkDetection() {
  const connectionMode = useStore((s) => s.connectionMode);
  const { homeUrl, singleServer } = useServerUrls();
  const checkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initialize API_BASE_URL on mount based on stored mode
  useEffect(() => {
    updateApiBaseUrl(connectionMode);
  }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      let cancelled = false;
      void detectWebConnectionMode().then((newMode) => {
        if (cancelled) return;
        const state = useStore.getState();
        if (state.connectionMode !== newMode) state.setConnectionMode(newMode);
      });
      return () => {
        cancelled = true;
      };
    }

    // One server: no LAN probe, timers or mode switching.
    if (singleServer) return;

    const detector = new NetworkProbeCoordinator(
      async () => {
        const res = await CapacitorHttp.request({
          url: `${homeUrl}/health`,
          method: 'GET',
          connectTimeout: 5000,
          readTimeout: 5000,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`HTTP ${res.status}`);
        }
        return true;
      },
      (newMode) => {
        if (newMode === 'remote' && isConnectionModeHeld()) {
          console.log(
            '[NetworkDetection] Deferring remote mode during local media preparation',
          );
          return;
        }
        if (useStore.getState().connectionMode === newMode) return;
        console.log(
          `[NetworkDetection] Detected network environment change to: ${newMode}`,
        );
        switchConnectionMode(newMode);
      },
    );

    let lastNetworkStatus: string | null = null;
    let burstTimers: ReturnType<typeof setTimeout>[] = [];
    const clearBurst = () => {
      burstTimers.forEach(clearTimeout);
      burstTimers = [];
    };

    // Android can repeat identical capability callbacks every few seconds, so
    // identical events are dropped, except for wifi: Android does not report
    // the SSID, so a move between Wi-Fi networks looks identical. Probes
    // serialize through the coordinator's inFlight.
    const handler = Network.addListener('networkStatusChange', (status) => {
      console.log('[NetworkDetection] Network status changed:', status);
      const statusKey = `${status.connected}:${status.connectionType}`;
      if (statusKey === lastNetworkStatus && status.connectionType !== 'wifi') {
        return;
      }
      lastNetworkStatus = statusKey;
      clearBurst();
      if (!status.connected) return;
      burstTimers = NETWORK_CHANGE_PROBE_DELAYS_MS.map((delay) =>
        setTimeout(() => void detector.check(), delay),
      );
    });

    const appStateHandler = App.addListener(
      'appStateChange',
      ({ isActive }) => {
        if (isActive) void detector.check();
      },
    );

    void detector.check();
    checkTimerRef.current = setInterval(() => void detector.check(), 15000);
    const unsubscribeHold = onConnectionModeHoldReleased(() => {
      void detector.check();
    });

    return () => {
      detector.stop();
      unsubscribeHold();
      clearBurst();
      handler.then((h) => h.remove());
      appStateHandler.then((h) => h.remove());
      if (checkTimerRef.current) clearInterval(checkTimerRef.current);
    };
  }, [homeUrl, singleServer]);
}
