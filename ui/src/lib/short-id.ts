/**
 * Short display form for an entity id.
 *
 * Ids are built as `<prefix>-<timestamp>-<random>` (users) or `<slug>-<random>`
 * (knowledge bases). The leading part is shared by every entity of that kind —
 * or by every entity carrying the same slug — so a badge built from the head
 * of the id renders identical text for different entities. The trailing random
 * segment is the part that actually tells them apart.
 */
export function shortEntityId(id: string): string {
  const tail = id.split('-').pop() || id;
  return tail.slice(-6);
}
