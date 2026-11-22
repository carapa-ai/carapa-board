/**
 * Isolates benchmark eval vectors from production Neo4j :Memory nodes.
 * Eval groups use the __eval__: prefix (separate label + vector index).
 */

export const EVAL_GROUP_PREFIX = '__eval__:';

export const PROD_MEMORY_LABEL = 'Memory';
export const EVAL_MEMORY_LABEL = 'EvalMemory';
export const PROD_VECTOR_INDEX = 'memory_embeddings';
const EVAL_VECTOR_INDEX = 'eval_memory_embeddings';

function isEvalGroup(group_folder: string): boolean {
  return group_folder.startsWith(EVAL_GROUP_PREFIX);
}

export function memoryLabelForGroup(
  group_folder: string,
): typeof PROD_MEMORY_LABEL | typeof EVAL_MEMORY_LABEL {
  return isEvalGroup(group_folder) ? EVAL_MEMORY_LABEL : PROD_MEMORY_LABEL;
}

/** Pick vector index for a scoped search. Refuses mixed eval + production folders. */
export function vectorIndexForGroups(groupFolders: string[]): string {
  if (groupFolders.length === 0) return PROD_VECTOR_INDEX;
  const evalCount = groupFolders.filter(isEvalGroup).length;
  if (evalCount === groupFolders.length) return EVAL_VECTOR_INDEX;
  if (evalCount === 0) return PROD_VECTOR_INDEX;
  throw new Error(
    'Cannot mix eval and production group folders in one vector search',
  );
}
