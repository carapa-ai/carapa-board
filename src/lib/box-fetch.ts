/**
 * Box-aware fetch for CarapaBox's streaming REST endpoints (browser viewer,
 * tmux). The local box is reached at CARAPA_BOX_URL; a project on a remote box
 * goes through that box's hub WebSocket. The box router installs the resolver
 * at startup; without it every request uses the local box.
 */
export interface BoxFetchArgs {
  /** IPC project `<stack>-<instance>` of the sandbox. */
  project?: string;
  instance?: string;
}

type BoxFetchResolver = (args: BoxFetchArgs) => typeof fetch;

let resolver: BoxFetchResolver | null = null;

export function setBoxFetchResolver(next: BoxFetchResolver | null): void {
  resolver = next;
}

export function boxFetchFor(args: BoxFetchArgs): typeof fetch {
  return resolver?.(args) ?? globalThis.fetch.bind(globalThis);
}
