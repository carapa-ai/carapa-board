import { useEffect, useId, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  HOME_URL,
  REMOTE_URL,
  type ServerConfig,
  buildServerLink,
  parseCertSha256,
  parseOtaPublicKey,
  parseServerUrl,
} from '@/lib/api-config';
import { fetchAndroidPairingInfo, fetchPresentedCertificate } from '@/lib/api';
import { copyToClipboard } from '@/lib/utils';
import { detectWebConnectionMode } from '@/hooks/use-network-detection';

type PairingInfo = { otaPublicKey: string | null };
/** What the board sees at one address; certSha256 null when unreachable. */
type PresentedCert = { certSha256: string | null; trusted: boolean };

/**
 * Web-UI section that turns the server addresses into a `carapaboard://`
 * setup link and QR code the Android app opens (scan with the phone camera).
 * The link carries origins plus, when chosen, the fingerprint of the
 * certificate each address presents and the OTA public key, never credentials.
 */
export function ConnectAndroidCard() {
  const fieldId = useId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [homeInput, setHomeInput] = useState('');
  const [remoteInput, setRemoteInput] = useState('');
  // null while loading; 'failed' when the endpoint could not be read.
  const [pairing, setPairing] = useState<PairingInfo | 'failed' | null>(null);
  // Per address URL; 'loading' while the board reads it.
  const [certs, setCerts] = useState<Record<string, PresentedCert | 'loading'>>(
    {},
  );
  // Explicit user choice per address; unset means the default below.
  const [pinChoice, setPinChoice] = useState<
    Partial<Record<'homeUrl' | 'remoteUrl', boolean>>
  >({});

  // Load the OTA key once.
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    let cancelled = false;
    void fetchAndroidPairingInfo()
      .then((info) => {
        if (!cancelled) {
          setPairing({ otaPublicKey: parseOtaPublicKey(info.otaPublicKey) });
        }
      })
      .catch(() => {
        if (!cancelled) setPairing('failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Prefill this origin once the home/remote classification has resolved,
  // and the other field with the board's configured address for that side
  // (VITE_LOCAL_IP / VITE_API_URL) when the build has two distinct ones,
  // without overwriting anything typed meanwhile.
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    let cancelled = false;
    void detectWebConnectionMode().then((mode) => {
      if (cancelled) return;
      const origin = window.location.origin;
      const [setThis, setOther, other] =
        mode === 'home'
          ? [setHomeInput, setRemoteInput, REMOTE_URL]
          : [setRemoteInput, setHomeInput, HOME_URL];
      setThis((current) => current || origin);
      if (HOME_URL !== REMOTE_URL && other !== origin) {
        setOther((current) => current || other);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fields = [
    { key: 'homeUrl', label: 'Home / LAN URL', value: homeInput },
    { key: 'remoteUrl', label: 'Remote URL', value: remoteInput },
  ] as const;
  const config: ServerConfig = {};
  const errors: Partial<Record<keyof ServerConfig, string>> = {};
  for (const { key, value } of fields) {
    if (!value.trim()) continue;
    const result = parseServerUrl(value);
    if ('error' in result) errors[key] = result.error;
    else config[key] = result.url;
  }
  const valid =
    Object.keys(errors).length === 0 && (config.homeUrl || config.remoteUrl);
  const info = pairing && pairing !== 'failed' ? pairing : null;
  const { homeUrl, remoteUrl } = config;

  // Ask the board which certificate each address presents, after typing
  // pauses. A reverse proxy in front of the board has its own certificate.
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    const urls = [homeUrl, remoteUrl].filter(
      (url): url is string => !!url && !(url in certs),
    );
    if (urls.length === 0) return;
    const timer = setTimeout(() => {
      for (const url of urls) {
        setCerts((current) => ({ ...current, [url]: 'loading' }));
        void fetchPresentedCertificate(url)
          .then((result) => ({
            certSha256: parseCertSha256(result.certSha256),
            trusted: result.trusted === true,
          }))
          .catch(() => ({ certSha256: null, trusted: false }))
          .then((result) =>
            setCerts((current) => ({ ...current, [url]: result })),
          );
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [homeUrl, remoteUrl, certs]);

  const presented = (key: 'homeUrl' | 'remoteUrl') => {
    const url = config[key];
    const cert = url ? certs[url] : undefined;
    return cert && cert !== 'loading' ? cert : null;
  };
  // Pin by default only when the certificate is not publicly trusted.
  const pinned = (key: 'homeUrl' | 'remoteUrl') => {
    const cert = presented(key);
    return !!cert?.certSha256 && (pinChoice[key] ?? !cert.trusted);
  };
  const homeCert = presented('homeUrl')?.certSha256;
  const remoteCert = presented('remoteUrl')?.certSha256;
  if (homeCert && pinned('homeUrl')) config.homeCertSha256 = homeCert;
  if (remoteCert && pinned('remoteUrl')) config.remoteCertSha256 = remoteCert;
  if (info?.otaPublicKey) config.otaPublicKey = info.otaPublicKey;
  // No code until every address has been read, so a scan never misses a pin.
  const certsPending = [homeUrl, remoteUrl].some(
    (url) => url && (!(url in certs) || certs[url] === 'loading'),
  );
  const link = valid && !certsPending ? buildServerLink(config) : null;

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    void import('qrcode').then((QRCode) => {
      if (!cancelled && canvasRef.current) {
        void QRCode.toCanvas(canvasRef.current, link, {
          width: 220,
          margin: 2,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [link]);

  // The app has its own Server editor; the QR is for another phone.
  if (Capacitor.isNativePlatform()) return null;

  return (
    <Card data-ui="connect-android-card">
      <CardContent className="p-6 space-y-4">
        <CardTitle className="text-base">Connect the Android app</CardTitle>
        <p className="text-sm text-muted-foreground">
          Scan the code with the phone camera while the app is signed out. The
          app asks before switching servers.
        </p>
        {fields.map(({ key, label, value }) => (
          <div key={key} className="space-y-1">
            <label htmlFor={`${fieldId}-${key}`} className="text-sm">
              {label}
            </label>
            <Input
              id={`${fieldId}-${key}`}
              type="url"
              placeholder="https://board.example.com"
              value={value}
              onChange={(e) =>
                (key === 'homeUrl' ? setHomeInput : setRemoteInput)(
                  e.target.value,
                )
              }
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={!!errors[key]}
            />
            {errors[key] && (
              <p className="text-xs text-destructive">{errors[key]}</p>
            )}
            {!errors[key] && presented(key)?.certSha256 && (
              <label className="flex items-start gap-2 text-xs">
                <Checkbox
                  className="mt-0.5"
                  checked={pinned(key)}
                  onCheckedChange={(checked) =>
                    setPinChoice((current) => ({
                      ...current,
                      [key]: checked === true,
                    }))
                  }
                />
                <span>
                  Pin the certificate this address presents (
                  {shortFingerprint(presented(key)!.certSha256!)})
                </span>
              </label>
            )}
            {!errors[key] && presented(key) && !presented(key)!.certSha256 && (
              <p className="text-xs text-muted-foreground">
                The board could not reach this address, so the link has no pin
                for it. The phone needs a certificate it already trusts.
              </p>
            )}
          </div>
        ))}
        {pairing === 'failed' && (
          <p className="text-xs text-muted-foreground">
            Could not load the board&apos;s update key. The link has no update
            key.
          </p>
        )}
        {link && (
          <div className="space-y-3">
            <canvas
              ref={canvasRef}
              className="rounded-md"
              aria-label="QR code with the server link"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () =>
                (await copyToClipboard(link))
                  ? toast.success('Link copied')
                  : toast.error('Could not copy the link')
              }
            >
              Copy link
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function shortFingerprint(sha256: string): string {
  return `${sha256.slice(0, 8)}…${sha256.slice(-8)}`;
}
