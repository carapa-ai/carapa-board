import { useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import { Check, Globe, Wifi, WifiOff } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { UnreadBell } from '@/components/notif/UnreadBell';
import { Tooltip } from '@/components/ui/tooltip';
import { useStore } from '@/store';
import { cn } from '@/lib/utils';
import { useServerUrls } from '@/hooks/use-server-urls';
import { switchConnectionMode } from '@/hooks/use-network-detection';
import { getServerConfig, subscribeServerConfig } from '@/lib/api-config';
import {
  type ConnectionMode,
  getLastProbeResult,
  subscribeProbeResult,
} from '@/lib/network-detection';

const MODE_OPTIONS: { mode: ConnectionMode; label: string }[] = [
  { mode: 'home', label: 'Home / LAN' },
  { mode: 'remote', label: 'Remote / Cloud' },
];

function ConnectionMenu({
  connectionMode,
  children,
}: {
  connectionMode: ConnectionMode;
  children: React.ReactNode;
}) {
  const probe = useSyncExternalStore(subscribeProbeResult, getLastProbeResult);
  const time = probe
    ? new Date(probe.at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  const probeLine = !probe
    ? 'LAN check pending'
    : probe.ok
      ? 'LAN reachable'
      : `LAN check ${time}: failed: ${probe.message}`;

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-56" data-ui="connection-menu">
        {MODE_OPTIONS.map(({ mode, label }) => (
          <button
            key={mode}
            type="button"
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            aria-pressed={connectionMode === mode}
            onClick={() => switchConnectionMode(mode)}
          >
            {label}
            {connectionMode === mode && <Check className="size-3.5" />}
          </button>
        ))}
        <p className="px-2 pt-1.5 text-xs text-muted-foreground">{probeLine}</p>
      </PopoverContent>
    </Popover>
  );
}

export function HeaderUtilities() {
  const connectionMode = useStore((state) => state.connectionMode);
  const websocketConnected = useStore((state) => state.websocketConnected);
  const { singleServer } = useServerUrls();
  const serverConfig = useSyncExternalStore(
    subscribeServerConfig,
    getServerConfig,
  );
  // A single native server is never probed, so the stored mode can be stale:
  // show where that server is (Remote only when a Remote address is set).
  const shownMode =
    Capacitor.isNativePlatform() && singleServer
      ? serverConfig.remoteUrl
        ? 'remote'
        : 'home'
      : connectionMode;

  const connection = !websocketConnected
    ? {
        label: 'Realtime updates disconnected',
        icon: <WifiOff className="size-3.5 text-red-600 dark:text-red-500" />,
      }
    : shownMode === 'home'
      ? {
          label: 'Connected directly (Home)',
          icon: (
            <Wifi className="size-3.5 text-emerald-700 dark:text-emerald-500" />
          ),
        }
      : {
          label: 'Connected via Cloudflare (Away)',
          icon: <Globe className="size-3.5 text-blue-600 dark:text-blue-400" />,
        };

  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      {/* Always visible, including on phones; only a lost connection gets a
          border so it stands out from the healthy state. */}
      <div
        className={cn(
          'flex items-center rounded-md p-0.5',
          !websocketConnected && 'border border-destructive/50',
        )}
      >
        {Capacitor.isNativePlatform() && !singleServer ? (
          // Touch only: no hover tooltip, the trigger opens the switch menu.
          <ConnectionMenu connectionMode={connectionMode}>
            <button
              type="button"
              className="flex items-center gap-1.5 px-1 py-1 sm:px-2"
              aria-label={`${connection.label}. Change connection`}
            >
              {connection.icon}
            </button>
          </ConnectionMenu>
        ) : (
          <Tooltip content={connection.label} side="bottom">
            <div
              className="flex items-center gap-1.5 px-1 py-1 sm:px-2"
              role="status"
              aria-label={connection.label}
            >
              {connection.icon}
            </div>
          </Tooltip>
        )}
      </div>
      <UnreadBell />
    </div>
  );
}
