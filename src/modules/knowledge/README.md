# Knowledge Module

Shared Knowledge Bases & Optional Two-Stage RAG for Carapa-board.

## Overview

This module provides a semantic search capability across curated "Knowledge Bases" (KB). Unlike the general `vector-store` module which handles short-term agent memory, this module is intended for long-term storage of documentation, research papers, news, and brainstorms.

## Features

- **Project Isolation**: Knowledge bases can be shared with specific projects or kept private.
- **Docling Integration**: Automatic conversion of PDF, DOCX, and XLSX to Markdown.
- **Retrieval**:
  - Stage 1: Fast vector search in Neo4j.
  - Optional Stage 2: High-precision LLM verification to eliminate structural mismatches.

## Configuration

The module is always enabled. Knowledge files are stored in `<CARAPA_DATA_DIR>/knowledge` (the `knowledge/` directory of the project root when `CARAPA_DATA_DIR` is unset); the path has no separate environment variable. The `knowledge` toolset is part of the default toolsets unless `ENABLE_MEMORY=false`.

## Tools

- `search_knowledge(query, limit)`: The primary tool for agents to retrieve information from shared knowledge bases.

## Internal Service

The `KnowledgeService` class provides methods for:

- `createKB(name, description)`
- `indexKB(kb_id)`
- `shareKB(kb_id, group_folder)`

For detailed architectural information, see [`docs/KNOWLEDGE_BASES.md`](../../../docs/KNOWLEDGE_BASES.md).
