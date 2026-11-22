export const MEMORY_CAPSULE_OPEN = '[MEMORY_CAPSULE]';
export const MEMORY_CAPSULE_CLOSE = '[/MEMORY_CAPSULE]';

export function stripMemoryCapsules(text: string): string {
  return text
    .replace(/\[MEMORY_CAPSULE\][\s\S]*?\[\/MEMORY_CAPSULE\]\s*/g, '')
    .trim();
}
