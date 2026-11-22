# Knowledge Bases & RAG System

Carapa-board features a robust, project-aware Knowledge Base system that utilizes a **Two-Stage Graph-Augmented RAG (Retrieval-Augmented Generation)** architecture. This system allows for centralized storage of documentation, research, and data, which can be selectively shared with specific projects.

## Architecture

The retrieval system is designed for high precision, specifically addressing common RAG failures like structural mismatches and negation flips.

### 1. Stage 1: Recall (Vector Search)

- **Engine**: Neo4j Vector Index.
- **Process**: When a query is made, it is embedded using the system's default embedding model (e.g., `nomic-embed-text`). A similarity search is performed against the `knowledge_embeddings` index in Neo4j to retrieve the top-k relevant chunks.
- **Scope**: Results are automatically filtered to include only chunks from Knowledge Bases shared with the active project.
- **Privacy mode**: strict projects cannot write into a Knowledge Base shared with a non-strict project; see [SECURITY.md section 12](SECURITY.md#12-project-privacy-mode-cross-project-reads).

### 2. Optional Stage 2: Precision (LLM Verifier)

- **Engine**: High-quality LLM (e.g., `Qwen 3.6` or `Gemma 4`).
- **Process**: When enabled, the candidate chunks from Stage 1 are passed to a "Verifier" agent. This agent examines the chunk against the query to ensure there is a semantic match and no structural mismatches (e.g., if the query asks for "benefits" and the doc describes "risks").
- **Output**: Only chunks that pass the verification are returned to the calling agent.

## Configuration

### Environment Variables

The following variables in your `.env` file control the Knowledge Base system:

- `CARAPA_DATA_DIR`: Base directory for data storage. KBs default to `${CARAPA_DATA_DIR}/knowledge`.
- `ENABLE_VECTOR_STORE`: Must be set to `true` to enable semantic search.
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`: Connection details for the Neo4j instance.
- `EMBEDDING_API_URL`: The endpoint for your embedding service (e.g., Ollama).
- `EMBEDDING_MODEL`: The model name to use for embeddings (e.g., `embeddinggemma`).
- `EMBEDDING_DIMENSIONS`: The vector size produced by your model (e.g., `768` for embeddinggemma).

### Knowledge Base Storage

Knowledge bases are stored as subdirectories within `${CARAPA_DATA_DIR}/knowledge`. Each subdirectory corresponds to a unique `kb_id`.

## Knowledge Hub UI

The **Knowledge Hub** provides a centralized interface for managing your RAG sources:

1.  **File Management**: Choose a collection to see its documents in the main area. Collection and document cards adapt to the available width; indexing, sharing, and other properties stay in the right pane on desktop and a Properties dialog on smaller screens.
2.  **Project Sharing**: Toggle which projects have access to specific Knowledge Bases.
3.  **Indexing Control**: Manually trigger re-indexing runs after uploading new documents.
4.  **Status Monitoring**: View when a KB was last indexed and the current sync status.

Select a document title or thumbnail to read it in the main area using the same viewer as the chat Files tab. Markdown is rendered with formatting and code highlighting; PDFs use the browser's inline PDF viewer. Other supported text and media formats use the shared preview, with a download option for unsupported or oversized files. The reader is read-only, and **Back to documents** returns to the current tag filters. On browsers without inline PDF support, download the file to read it.

## Document tags and thumbnails

Tags are stored in `knowledge_documents`, keyed by KB ID and full relative document path. Content remains in files. Tag names retain their display spelling, are trimmed, and match/deduplicate case-insensitively; empty names are rejected. Existing documents have no tags. Editing tags does not regenerate embeddings.

Each collection has its own tag suggestions and document counts. The editor accepts existing or new tags. Selecting several filters requires **all** selected tags. Agents use the same matching rules: tag-filtered semantic search ranks only matching authorized KB/path pairs with exact cosine similarity before applying the result limit and verifier. Keyword fallback observes the same restriction; unknown tags return no results.

A document can have a thumbnail image in the same directory with the same basename, such as `research/article.md` and `research/article.jpg`. Supported image extensions, in preference order if several exist, are WebP, PNG, JPG, JPEG, AVIF, and GIF. Matching images appear on document cards and are excluded from document counts and indexing. Unpaired images remain standalone documents. Deleting a document removes its thumbnail unless another document with the same basename still uses it.

The upload endpoint accepts optional `tags` and returns the actual saved `path` after duplicate-name handling. Importers should upload the document first, then use that returned basename for its image. `PATCH /api/knowledge/:id/files/metadata` replaces tags using `{ filename, tags }`; `GET /api/knowledge/:id/tags` returns names and counts. The file list returns `title`, `description`, `sourceUrl` and `publishedAt` for each document, and the UI shows the title and a source link. Document reads use `/api/knowledge/:id/files/content?filename=...`; thumbnails use `/api/knowledge/:id/files/thumbnail?filename=...`. Encode the full relative filename as a query value so reverse proxies cannot change its signed path. Both endpoints retain KB access and signed-request requirements. The original filename-in-path routes remain available for existing clients.

## Data Ingestion

### Document Conversion

Carapa-board uses a tiered approach for document conversion:

- **Markdown & Text**: Ingested directly (`.md`, `.txt`).
- **PDF**: Ingested via the lightweight `pdf-parse` library (text-only).
- **Advanced (Docling)**: For complex layouts, tables, and Office documents (`.docx`, `.xlsx`), a Python bridge to **Docling** is available but requires Python 3 in the container.

### Chunking & Embedding

- **Chunk Size**: 1000 characters (default).
- **Overlap**: 100 characters (default).
- **Indexing**: During the indexing process, chunks are embedded and stored in Neo4j with metadata including the source file path and chunk index.

## Usage for Agents

The `knowledge` toolset is available **by default** for all agents (unless `ENABLE_MEMORY=false`, which removes the `memory` and `knowledge` toolsets from the defaults). They can access knowledge using the `search_knowledge` tool.

### `search_knowledge`

- **Arguments**:
  - `query`: The question or topic to search for.
  - `limit`: (Optional) The maximum number of results to return (default: 5).
  - `tags`: (Optional) All tags that a matching document must have.
  - `verify`: (Optional) Enable the slower LLM precision verifier (default: `false`).
- **Behavior**: This tool automatically identifies which Knowledge Bases are shared with the agent's current project and performs vector/keyword retrieval. When `verify` is `true`, it also performs the precision pass.

**Telemetry**: every search emits exactly one counts-only `knowledge_search` log line (info level) with the fields `project`, `kbCount`, `tagFiltered`, `embedded`, `vectorHits` (null when the vector search was not called), `afterMetadataFilter`, `path` (`vector`, `keyword` or `none`), `keywordHits` (null when the keyword fallback did not run), `returned`, `topScore` and `minReturnedScore` (of the returned chunks, 3 decimals, or null), `verify`, `verifiedCount` (null without `verify`), `durationMs`, and, for early returns only, `reason` (`no_kbs`, `kb_filter_empty`, `tag_filter_empty` or `no_candidates`). A search that throws still logs its line, with `failed: true`, and the error propagates unchanged. No query text, chunk content, filenames, tags or KB names are logged.

### Tag discovery and saving

- `list_knowledge_tags` lists tags and document counts separately for each accessible KB; optional `kb_id` or `kb_name` narrows the selection.
- `save_to_knowledge` accepts optional `tags`, preserved through the regular upload service.
- Search results include the document's current tags.

## Sharing Model

Knowledge Bases are globally defined but **isolated by default**.

- **Metadata**: Stored in the DB `knowledge_bases` table.
- **Sharing**: Access is granted via the `knowledge_base_shares` table, which maps `knowledge_base_id` to `group_folder` (project slug).
- **Security**: The `search_knowledge` tool enforces these shares at runtime, ensuring agents cannot access knowledge that hasn't been explicitly shared with their project.
