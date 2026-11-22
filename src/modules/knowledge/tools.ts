import { z } from 'zod';
import { ToolDefinition } from '../tools/types.js';
import { KnowledgeService } from './knowledge-service.js';
import { knowledgeDateSchema, parseKnowledgeDate } from './dates.js';
import { knowledgeTagsSchema } from './tags.js';
import { readThumbnailSource } from './thumbnail-source.js';
import { hasPermission } from '../../mcp/auth.js';
import {
  getKbAccessLevel,
  getReachableKbIds,
  adminBypassesKb,
  KB_LEVEL_RANK,
} from './db-kb.js';
import { assertKnowledgeWriteAllowed } from './write-privacy.js';
import type { KnowledgeBase } from './types.js';
import { logger } from '../../logger.js';
import {
  crossProjectReadAllowed,
  PrivacyRefusal,
} from '../../lib/privacy-policy.js';

const targetProjectSchema = z
  .string()
  .optional()
  .describe(
    'Project whose shared knowledge bases to use; defaults to the current project.',
  );

type KbToolContext = Parameters<ToolDefinition['handler']>[2];

/**
 * Project folder a KB tool acts on. Another project than the context's own
 * needs `memories:read` (or `memories:write` for writes) on that folder, and
 * the cross-project privacy rule must allow the calling project as reader.
 * An OAuth grant holds different access per project, so its home folder is
 * checked too: a read-only home project must not be written through a grant
 * that is writable elsewhere.
 */
function resolveKbFolder(
  context: KbToolContext,
  targetProject: string | undefined,
  access: 'read' | 'write',
): string {
  const folder = targetProject || context.group_folder;
  if (
    (folder !== context.group_folder || context.kind === 'oauth') &&
    !hasPermission(context.permissions, folder, `memories:${access}`)
  )
    throw new Error(
      `Unauthorized: no knowledge access for project "${folder}"`,
    );
  if (
    folder !== context.group_folder &&
    !crossProjectReadAllowed(folder, context.group_folder, 'agent')
  ) {
    logger.info(
      {
        event: 'privacy_cross_project_skip',
        path: 'knowledge',
        reader: context.group_folder ?? null,
      },
      'privacy_cross_project_skip',
    );
    throw new PrivacyRefusal({
      projectId: context.group_folder,
      purpose: 'agent',
      mode: 'strict',
      target: 'project',
      message:
        'Privacy mode refuses knowledge access to a project this project may not read',
    });
  }
  return folder;
}

const isKbRoleRestricted = (context: KbToolContext): boolean =>
  context.kind === 'oauth';

/**
 * Knowledge bases shared with `folder`. For a role-restricted OAuth user, KBs
 * without a membership row are dropped so they are indistinguishable from KBs
 * that are not shared.
 */
async function getVisibleKbs(
  context: KbToolContext,
  folder: string,
): Promise<KnowledgeBase[]> {
  const shared = await KnowledgeService.getSharedKBs(folder);
  const userId = context.oauth_user_id;
  if (!isKbRoleRestricted(context)) return shared;
  if (!userId) return [];
  const reachable = await getReachableKbIds(
    { id: userId, role: context.oauth_user_is_admin ? 'admin' : undefined },
    shared.map((kb) => kb.id),
  );
  return shared.filter((kb) => reachable.has(kb.id));
}

/** Role-restricted OAuth users need at least editor on a KB to change it. */
async function assertKbWritable(
  context: KbToolContext,
  kb: KnowledgeBase,
): Promise<void> {
  if (!isKbRoleRestricted(context)) return;
  if (
    await adminBypassesKb(
      {
        role:
          context.oauth_user_is_admin && context.oauth_user_id
            ? 'admin'
            : undefined,
      },
      kb.id,
    )
  )
    return;
  const level = context.oauth_user_id
    ? await getKbAccessLevel(context.oauth_user_id, kb.id)
    : null;
  if (!level || KB_LEVEL_RANK[level] < KB_LEVEL_RANK.editor)
    throw new Error(
      `Unauthorized: knowledge base "${kb.name}" is read-only for you`,
    );
}

const documentMetadataSchema = z
  .object({
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    sourceUrl: z
      .url({ protocol: /^https?$/ })
      .nullable()
      .optional(),
    publishedAt: knowledgeDateSchema.nullable().optional(),
  })
  .strict();

export const search_knowledge: ToolDefinition = {
  name: 'search_knowledge',
  description:
    'Search across shared knowledge bases for facts, documentation, news, and brainstorms. Use this for general knowledge that is not in the codebase. Optional target_project selects the shared knowledge bases of another project (needs a memories permission on it).',
  inputSchema: {
    query: z.string().describe('The search query or question to answer.'),
    tags: knowledgeTagsSchema
      .optional()
      .describe(
        'Only search documents with ALL of these tags (case-insensitive). Use list_knowledge_tags to discover available tags.',
      ),
    limit: z
      .number()
      .optional()
      .default(5)
      .describe('Maximum number of results to return.'),
    verify: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Run the slower LLM precision verifier on the retrieved chunks. Defaults to false; enable when high-precision filtering is needed.',
      ),
    kb_id: z
      .string()
      .optional()
      .describe('Filter search to only this specific Knowledge Base ID.'),
    kb_name: z
      .string()
      .optional()
      .describe('Filter search to only this specific Knowledge Base Name.'),
    target_project: targetProjectSchema,
  },
  handler: async (args, deps, context) => {
    const { query, limit, kb_id, kb_name, tags, verify, target_project } = args;

    if (!context.group_folder) {
      throw new Error('group_folder is required to search knowledge');
    }
    const folder = resolveKbFolder(context, target_project, 'read');

    const results = await KnowledgeService.searchKnowledge(
      folder,
      query,
      limit,
      kb_id,
      kb_name,
      tags,
      verify,
      isKbRoleRestricted(context)
        ? (await getVisibleKbs(context, folder)).map((kb) => kb.id)
        : undefined,
      context.group_folder,
    );

    if (results.length === 0) {
      return 'No relevant knowledge found in the shared knowledge bases.';
    }

    return results
      .map((r) => {
        const source = r.metadata.source
          ? ` (Source: ${r.metadata.source})`
          : '';
        const tags = r.metadata.tags?.length
          ? ` (Tags: ${r.metadata.tags.join(', ')})`
          : '';
        return `--- KNOWLEDGE CHUNK${source}${tags} ---\n${r.content}`;
      })
      .join('\n\n');
  },
};

export const save_to_knowledge: ToolDefinition = {
  name: 'save_to_knowledge',
  description:
    "Save information, research, or summaries to a project knowledge base (notebook), with optional tags, title, description, source URL, and the article's own publication date (publishedAt). The added date is recorded automatically. Optional target_project selects the shared knowledge bases of another project (needs a memories permission on it).",
  inputSchema: {
    content: z.string().describe('The markdown or text content to save.'),
    metadata: documentMetadataSchema
      .optional()
      .describe(
        'Optional title, description, HTTP(S) sourceUrl, and publishedAt (ISO date or datetime of the article itself). Use the top-level tags field for document tags.',
      ),
    tags: knowledgeTagsSchema
      .optional()
      .describe(
        'Tags to attach to this document. Existing tag spelling is preserved; duplicates are case-insensitive.',
      ),
    filename: z
      .string()
      .optional()
      .describe(
        'Desired filename (e.g., "market-research.md"). If omitted, one will be generated.',
      ),
    kb_id: z
      .string()
      .optional()
      .describe('The ID of the knowledge base to save to.'),
    kb_name: z
      .string()
      .optional()
      .describe('The name of the knowledge base (alternative to kb_id).'),
    target_project: targetProjectSchema,
  },
  handler: async (args, deps, context) => {
    const { content, filename, kb_id, kb_name, tags, target_project } = args;
    const metadata = documentMetadataSchema.optional().parse(args.metadata);

    if (!context.group_folder) {
      throw new Error('group_folder is required to save knowledge');
    }
    const folder = resolveKbFolder(context, target_project, 'write');

    // 1. Resolve KB
    const sharedKbs = await getVisibleKbs(context, folder);

    if (sharedKbs.length === 0) {
      throw new Error(
        'No knowledge bases are shared with this project. Please create one first.',
      );
    }

    let targetKb = sharedKbs[0]; // Default to first shared KB

    if (kb_id) {
      const found = sharedKbs.find((k) => k.id === kb_id);
      if (!found)
        throw new Error(
          `Knowledge base with ID "${kb_id}" not found or not shared with this project.`,
        );
      targetKb = found;
    } else if (kb_name) {
      const found = sharedKbs.find(
        (k) => k.name.toLowerCase() === kb_name.toLowerCase(),
      );
      if (!found)
        throw new Error(
          `Knowledge base with name "${kb_name}" not found or not shared with this project.`,
        );
      targetKb = found;
    }

    await assertKbWritable(context, targetKb);
    await assertKnowledgeWriteAllowed(targetKb.id, folder);
    if (folder !== context.group_folder)
      await assertKnowledgeWriteAllowed(targetKb.id, context.group_folder);

    // 2. Generate unique filename if needed
    let finalFilename = filename;
    if (!finalFilename) {
      finalFilename = await KnowledgeService.generateFilename(
        content,
        context.group_folder,
      );
    }

    if (!finalFilename.endsWith('.md') && !finalFilename.endsWith('.txt')) {
      finalFilename += '.md';
    }

    // 3. Save file
    const savedPath = await KnowledgeService.addFile(
      targetKb.id,
      finalFilename,
      Buffer.from(content),
      tags,
      metadata,
    );

    // addFile already indexes the new file in the background.

    return `Successfully saved to "${targetKb.name}" as "${savedPath}". It is now being indexed and will be available for search shortly.`;
  },
};

export const list_knowledge_tags: ToolDefinition = {
  name: 'list_knowledge_tags',
  description:
    'List tag names and document counts per knowledge base shared with this project. Optional target_project selects the shared knowledge bases of another project (needs a memories permission on it).',
  inputSchema: {
    kb_id: z
      .string()
      .optional()
      .describe('Only list tags for this shared Knowledge Base ID.'),
    kb_name: z
      .string()
      .optional()
      .describe('Only list tags for this shared Knowledge Base name.'),
    target_project: targetProjectSchema,
  },
  handler: async ({ kb_id, kb_name, target_project }, _deps, context) => {
    if (!context.group_folder)
      throw new Error('group_folder is required to list knowledge tags');
    const folder = resolveKbFolder(context, target_project, 'read');
    let kbs = await getVisibleKbs(context, folder);
    if (kb_id) kbs = kbs.filter((kb) => kb.id === kb_id);
    else if (kb_name)
      kbs = kbs.filter((kb) => kb.name.toLowerCase() === kb_name.toLowerCase());
    return JSON.stringify(
      await Promise.all(
        kbs.map(async (kb) => ({
          kbId: kb.id,
          kbName: kb.name,
          tags: await KnowledgeService.listTags(kb.id),
        })),
      ),
    );
  },
};

const documentListSchema = z.object({
  kb_id: z
    .string()
    .min(1)
    .describe('ID of a knowledge base shared with this project.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Document offset; use nextOffset from the previous page.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum documents per page (1–200).'),
  added_after: knowledgeDateSchema
    .optional()
    .describe(
      'Only list documents added strictly after this ISO date or datetime. Applied before pagination; total and nextOffset refer to the filtered list.',
    ),
  target_project: targetProjectSchema,
});

export const list_knowledge_documents: ToolDefinition = {
  name: 'list_knowledge_documents',
  description:
    "Enumerate documents and their current tags, title, description, sourceUrl, and dates in a shared knowledge base without relying on search or indexing. Each document has addedAt (when first added to the knowledge base), modifiedAt (file last modified), and publishedAt (the article's own publication date, or null), as ISO strings. Use added_after to see only newly added documents. Sorted by filename; follow nextOffset until null to read every document. Thumbnail sidecars are excluded. Avoid adding, deleting, or renaming documents while paging; metadata updates do not change pagination. Optional target_project selects the shared knowledge bases of another project (needs a memories permission on it).",
  inputSchema: documentListSchema.shape,
  handler: async (args, _deps, context) => {
    if (!context.group_folder)
      throw new Error('group_folder is required to list knowledge documents');
    const { kb_id, offset, limit, added_after, target_project } =
      documentListSchema.parse(args);
    const folder = resolveKbFolder(context, target_project, 'read');
    const kbs = await getVisibleKbs(context, folder);
    if (!kbs.some((kb) => kb.id === kb_id))
      throw new Error(
        'Knowledge base not found or not shared with this project',
      );
    return JSON.stringify({
      kbId: kb_id,
      ...(await KnowledgeService.listDocuments(
        kb_id,
        offset,
        limit,
        added_after
          ? (parseKnowledgeDate(added_after) ?? undefined)
          : undefined,
      )),
    });
  },
};

const documentUpdateSchema = z.object({
  kb_id: z
    .string()
    .min(1)
    .describe('ID of the knowledge base shared with this project.'),
  filename: z
    .string()
    .min(1)
    .describe('Exact existing document path within the knowledge base.'),
  content: z
    .string()
    .optional()
    .describe(
      'Complete replacement text for a .md or .txt document. Omit to preserve content.',
    ),
  metadata: documentMetadataSchema
    .extend({
      tags: knowledgeTagsSchema
        .optional()
        .describe('Complete replacement tag list; [] clears tags.'),
    })
    .strict()
    .optional()
    .describe(
      'Only supplied fields change. Use null to clear title, description, sourceUrl, or publishedAt (ISO date or datetime).',
    ),
  thumbnailSourcePath: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'Path to a PNG, JPEG, WebP, or GIF image in this project sandbox or artifacts (maximum 10 MB). For generated images use their returned path. Copies the file as the thumbnail; null removes it and omission preserves it.',
    ),
  target_project: targetProjectSchema,
});

export const update_knowledge_document: ToolDefinition = {
  name: 'update_knowledge_document',
  description:
    'Update an existing shared knowledge document in place: content, tags, title, description, source URL, publication date, or thumbnail. Read it with read_knowledge_document first. Omitted fields are preserved; no duplicate document is created. Content changes trigger background search indexing. Optional target_project selects the shared knowledge bases of another project (needs a memories permission on it).',
  inputSchema: documentUpdateSchema.shape,
  handler: async (args, _deps, context) => {
    const { group_folder } = context;
    if (!group_folder)
      throw new Error('group_folder is required to update knowledge');
    const { kb_id, filename, thumbnailSourcePath, target_project, ...updates } =
      documentUpdateSchema.parse(args);
    const folder = resolveKbFolder(context, target_project, 'write');
    const kb = (await getVisibleKbs(context, folder)).find(
      (candidate) => candidate.id === kb_id,
    );
    if (!kb)
      throw new Error(
        'Knowledge base not found or not shared with this project',
      );
    await assertKbWritable(context, kb);
    await assertKnowledgeWriteAllowed(kb_id, folder);
    if (folder !== group_folder)
      await assertKnowledgeWriteAllowed(kb_id, group_folder);
    if (
      updates.content === undefined &&
      thumbnailSourcePath === undefined &&
      !Object.keys(updates.metadata ?? {}).length
    )
      throw new Error(
        'Provide content, metadata, or thumbnailSourcePath to update',
      );
    const details = await KnowledgeService.updateDocument(kb_id, filename, {
      ...updates,
      thumbnail:
        thumbnailSourcePath === undefined
          ? undefined
          : thumbnailSourcePath === null
            ? null
            : // The thumbnail is read from the caller's own project files.
              await readThumbnailSource(group_folder, thumbnailSourcePath),
    });
    return JSON.stringify({ kbId: kb_id, filename, ...details });
  },
};

/** Read an explicit chat document reference without depending on vector indexing. */
export const read_knowledge_document: ToolDefinition = {
  name: 'read_knowledge_document',
  description:
    'Read a document from a knowledge base shared with this project. For chat links /api/knowledge/<kb_id>/files/content?filename=..., use the KB ID and decoded filename from the link. Returns paginated content plus complete metadata, file details (including addedAt, modifiedAt, and publishedAt as ISO strings or null), and thumbnail information without vector indexing. Follow nextOffset until null for all content. Text is exact for .md/.txt and extracted for other formats. Binary document content cannot be updated. Optional target_project selects the shared knowledge bases of another project (needs a memories permission on it).',
  inputSchema: {
    kb_id: z
      .string()
      .min(1)
      .describe('Knowledge base ID from the document link.'),
    filename: z
      .string()
      .min(1)
      .describe('Exact document path within the knowledge base.'),
    metadataOnly: z
      .boolean()
      .default(false)
      .describe(
        'Return metadata and thumbnail information without extracting document content.',
      ),
    target_project: targetProjectSchema,
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Character offset for the next page.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20000)
      .default(12000)
      .describe('Maximum characters to return.'),
  },
  handler: async (
    {
      kb_id,
      filename,
      offset = 0,
      limit = 12000,
      metadataOnly = false,
      target_project,
    },
    _deps,
    context,
  ) => {
    if (!context.group_folder)
      throw new Error('group_folder is required to read knowledge');
    const folder = resolveKbFolder(context, target_project, 'read');
    const kbs = await getVisibleKbs(context, folder);
    if (!kbs.some((kb) => kb.id === kb_id)) {
      throw new Error(
        'Knowledge base not found or not shared with this project',
      );
    }
    const details = await KnowledgeService.readDocumentDetails(kb_id, filename);
    const content = metadataOnly
      ? ''
      : await KnowledgeService.readDocument(kb_id, filename);
    const end = Math.min(offset + limit, content.length);
    return JSON.stringify({
      kbId: kb_id,
      filename,
      ...details,
      content: content.slice(offset, end),
      nextOffset: end < content.length ? end : null,
      totalCharacters: content.length,
    });
  },
};
