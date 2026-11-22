import { z } from 'zod';

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** Parse an ISO date (YYYY-MM-DD) or datetime with offset; null when invalid. */
export function parseKnowledgeDate(value: string): Date | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Validate the local calendar date independently of the datetime offset.
  const datePart = value.slice(0, 10);
  const calendarDate = new Date(`${datePart}T00:00:00Z`);
  if (
    Number.isNaN(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== datePart ||
    (value.length > 10 && Number(value.slice(11, 13)) > 23)
  )
    return null;
  return date;
}

/** Zod string schema accepting an ISO date or datetime. */
export const knowledgeDateSchema = z
  .string()
  .refine((value) => parseKnowledgeDate(value) !== null, {
    message: 'Expected an ISO date (YYYY-MM-DD) or datetime',
  });
