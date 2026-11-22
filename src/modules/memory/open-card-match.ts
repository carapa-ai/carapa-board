import type { Task } from '../kanban/types.js';

/** Match only reference IDs in the memory's last parenthesized group. */
export function matchOpenCardReference(
  content: string,
  cards: readonly Pick<Task, 'id' | 'title' | 'description'>[],
): { cardId: string; token: string } | null {
  const groups = [...content.matchAll(/\(([^()]*)\)/g)];
  const tokens = groups.at(-1)?.[1].match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [];
  for (const card of cards) {
    const cardTokens = new Set(
      `${card.title}\n${card.description}`.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ??
        [],
    );
    const token = tokens.find((candidate) => cardTokens.has(candidate));
    if (token) return { cardId: card.id, token };
  }
  return null;
}
