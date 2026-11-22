export const SHOW_BUILD_LOG_EVENT = 'carapa:show-build-log';

/** Ask the mounted BuildLogHost to open the build log dialog. */
export function showBuildLog(output: string, title?: string): void {
  window.dispatchEvent(
    new CustomEvent(SHOW_BUILD_LOG_EVENT, { detail: { output, title } }),
  );
}
