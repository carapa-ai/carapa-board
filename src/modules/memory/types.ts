// Memory types

export type MemoryType =
  | 'identity'
  | 'project'
  | 'goal'
  | 'decision'
  | 'preference'
  | 'contact'
  | 'event'
  | 'task';

export interface Memory {
  id: string;
  group_folder: string;
  objective_id?: string | null; // null = project-wide, set = objective-scoped
  content: string;
  memory_type: MemoryType;
  importance: number;
  source: 'user' | 'agent' | 'observer';
  sourceRef?: string;
  tags?: string[]; // stored as JSON in DB
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  access_count: number;
  superseded_by?: string;
  valid_from?: string | null; // when the fact became true (defaults to created_at)
  valid_to?: string | null; // when the fact stopped being true (null = currently valid)
}
