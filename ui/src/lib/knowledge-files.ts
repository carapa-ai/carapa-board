export function isKnowledgeFileContentUrl(url: string): boolean {
  return /\/api\/knowledge\/[^/]+\/files\/(?:[^/]+\/)?content(?:\?|$)/.test(
    url,
  );
}

/** Keep filenames out of URL paths: proxies can normalize encoded slashes there. */
export function knowledgeDocumentUrl(
  kbId: string,
  filename: string,
  kind: 'content' | 'thumbnail',
): string {
  return `/api/knowledge/${encodeURIComponent(kbId)}/files/${kind}?${new URLSearchParams({ filename })}`;
}
