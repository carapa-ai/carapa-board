export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  folder_path: string;
  last_indexed_at: number | null;
  created_at: number;
}

export interface KnowledgeChunk {
  id: string;
  knowledge_base_id: string;
  content: string;
  metadata: Record<string, any>;
  embedding?: number[];
}

export interface KnowledgeFile {
  name: string;
  size: number;
  mtime: number;
  /** ISO time the document was first added (stored, else file birthtime/mtime). */
  addedAt: string;
  /** ISO publication date of the article itself, when set. */
  publishedAt: string | null;
  title: string | null;
  description: string | null;
  sourceUrl: string | null;
  tags: string[];
  thumbnail?: { name: string; mtime: number };
}

export interface KnowledgeTag {
  name: string;
  count: number;
}

export interface KnowledgeDocumentSource {
  kbId: string;
  path: string;
}

export interface KnowledgeDocumentMetadata {
  tags: string[];
  title: string | null;
  description: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
}

export interface KnowledgeDocumentUpdate {
  content?: string;
  metadata?: Partial<KnowledgeDocumentMetadata>;
  thumbnail?: Buffer | null;
}

export interface KnowledgeDocumentSummary extends KnowledgeDocumentMetadata {
  filename: string;
  addedAt: string;
  modifiedAt: string;
}
