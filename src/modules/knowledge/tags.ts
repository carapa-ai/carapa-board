import { z } from 'zod';

/** Keep display spelling while using one identity for editing and retrieval. */
export function tagKey(tag: string): string {
  return tag.trim().toLowerCase();
}

export const knowledgeTagsSchema = z.array(z.string().trim().min(1));

export function normalizeKnowledgeTags(value: unknown): string[] {
  const tags = knowledgeTagsSchema.parse(value);
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tagKey(tag);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function matchesKnowledgeTags(
  tags: string[],
  selected: string[],
): boolean {
  const keys = new Set(tags.map(tagKey));
  return selected.every((tag) => keys.has(tagKey(tag)));
}
