/**
 * Where an approved platform/template proposal lands in its source repository.
 *
 * Shared by the Board (preview and payload) and by `promotion-apply.ts`, which
 * runs in the promotion sandbox, so both derive the same repo-relative paths.
 */
import { z } from 'zod';
import {
  MAX_FILES,
  NAME_PATTERN,
  ITEM_PROPOSAL_KINDS,
  ProposalValidationError,
  type ItemProposalKind,
  type TargetLayer,
} from './actions.js';

const PROMOTION_LAYERS = [
  'platform',
  'group_template',
  'objective_template',
] as const;
export type PromotionLayer = (typeof PROMOTION_LAYERS)[number];

export function isPromotionLayer(layer: TargetLayer): layer is PromotionLayer {
  return (PROMOTION_LAYERS as readonly string[]).includes(layer);
}

type PromotionRepo = 'carapa-agent-kit';

export interface PromotionTarget {
  repo: PromotionRepo;
  commitPrefix: 'platform:' | 'group:' | 'objective:';
  /** Repo-relative path of the rule file or skill folder. */
  itemPath: string;
}

const LAYER_ROOTS: Record<
  PromotionLayer,
  Pick<PromotionTarget, 'commitPrefix'> & { skills: string; rules: string }
> = {
  platform: {
    commitPrefix: 'platform:',
    skills: 'platform/skills',
    rules: 'platform/rules',
  },
  group_template: {
    commitPrefix: 'group:',
    skills: 'brain/group/skills',
    rules: 'brain/group/rules',
  },
  objective_template: {
    commitPrefix: 'objective:',
    skills: 'brain/objective/skills',
    rules: 'brain/objective/rules',
  },
};

export function promotionTarget(
  layer: PromotionLayer,
  kind: ItemProposalKind,
  name: string,
): PromotionTarget {
  if (!NAME_PATTERN.test(name)) {
    throw new ProposalValidationError(
      `Invalid name "${name}": must match ${NAME_PATTERN.source}`,
    );
  }
  const roots = LAYER_ROOTS[layer];
  return {
    repo: 'carapa-agent-kit',
    commitPrefix: roots.commitPrefix,
    itemPath:
      kind === 'skill'
        ? `${roots.skills}/${name}`
        : `${roots.rules}/${name}.md`,
  };
}

/** The repo-relative file paths a write_item action produces. */
export function promotionFilePaths(
  target: PromotionTarget,
  kind: ItemProposalKind,
  files: readonly { path: string }[],
): string[] {
  if (kind === 'rule') return [target.itemPath];
  return files.map((file) => `${target.itemPath}/${file.path}`);
}

/** What Board sends the promotion script. Never placed on a command line. */
export const promotionPayloadSchema = z
  .object({
    proposalId: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
    title: z.string().min(1).max(200),
    layer: z.enum(PROMOTION_LAYERS),
    kind: z.enum(ITEM_PROPOSAL_KINDS),
    name: z.string(),
    repoDir: z.string().startsWith('/'),
    branch: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$/),
    /** Hash of the target as proposed against; null only for `hash` mode. */
    baseHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    files: z
      .array(z.object({ path: z.string(), content: z.string() }).strict())
      .min(1)
      .max(MAX_FILES),
  })
  .strict();
export type PromotionPayload = z.infer<typeof promotionPayloadSchema>;

/** Largest payload, and largest base item, the promotion script handles. */
export const MAX_PROMOTION_BYTES = 2 * 1024 * 1024;

/**
 * The item as it is in the repository when `hash` mode runs, written by the
 * script next to the payload as `base.json`. Paths are relative to the item; a
 * rule is its one `<name>.md` file. An empty list means the item does not exist.
 * A file that is not valid UTF-8 text (or holds a NUL, which JSONB rejects) is
 * carried as base64, and a symbolic link as its target (`symlink`), never
 * followed, so any existing item can be stored losslessly.
 */
export const promotionBaseSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string(),
            content: z.string(),
            encoding: z.enum(['base64', 'symlink']).optional(),
          })
          .strict(),
      )
      .max(MAX_FILES),
  })
  .strict();
export type PromotionBase = z.infer<typeof promotionBaseSchema>;
export type PromotionBaseFile = PromotionBase['files'][number];
