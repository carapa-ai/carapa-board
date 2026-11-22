// A leading scheme ("ftp://x", "about:blank", "javascript:x"). "host:3000" is a
// host and port, not a scheme, except for well-known non-HTTP schemes, which
// stay schemes even with a numeric payload ("javascript:123").
const UNSUPPORTED_SCHEMES =
  'javascript|vbscript|data|file|ftp|mailto|tel|sms|blob|ws|wss|view-source|chrome|about';
const HAS_SCHEME = new RegExp(
  `^(?:(?:${UNSUPPORTED_SCHEMES}):|[a-z][a-z0-9+.-]*:(?!\\d+(?:[/?#]|$)))`,
  'i',
);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function hostOf(input: string): string {
  const authority = input.split(/[/?#]/, 1)[0];
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.startsWith('['))
    return hostPort.slice(0, hostPort.indexOf(']') + 1);
  return hostPort.split(':', 1)[0];
}

/**
 * Add a missing scheme to an App URL typed in the Browser tab: `http://` for
 * local hosts (localhost, IP addresses, `.local`, single-label names such as a
 * docker service), `https://` otherwise. Input with a scheme is returned
 * unchanged so the server keeps rejecting unsupported ones.
 */
export function withAppUrlScheme(input: string): string {
  const value = input.trim();
  if (!value || HAS_SCHEME.test(value)) return value;
  const host = hostOf(value).toLowerCase();
  const local =
    host === 'localhost' ||
    host.startsWith('[') ||
    IPV4.test(host) ||
    host.endsWith('.local') ||
    !host.includes('.');
  return `${local ? 'http' : 'https'}://${value}`;
}
