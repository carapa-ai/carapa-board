import {
  Target,
  CheckCircle,
  AlertCircle,
  Pause,
  FileText,
} from 'lucide-react';
import type { ObjectiveStatus } from '@/types';

export interface ObjectiveStatusConfig {
  label: string;
  icon: typeof Target;
  color: string;
  bg: string;
}

export const objectiveStatusConfig: Record<
  ObjectiveStatus,
  ObjectiveStatusConfig
> = {
  draft: {
    label: 'Draft',
    icon: FileText,
    color: 'text-zinc-600 dark:text-zinc-400',
    bg: 'bg-zinc-500/10 border-zinc-600 dark:bg-zinc-400/15 dark:border-zinc-400/30',
  },
  active: {
    label: 'Active',
    icon: Target,
    color: 'text-cyan-700 dark:text-cyan-400',
    bg: 'bg-cyan-500/10 border-cyan-600 dark:bg-cyan-400/15 dark:border-cyan-400/30',
  },
  achieved: {
    label: 'Achieved',
    icon: CheckCircle,
    color: 'text-green-700 dark:text-green-400',
    bg: 'bg-green-500/10 border-green-600 dark:bg-green-400/15 dark:border-green-400/30',
  },
  failed: {
    label: 'Failed',
    icon: AlertCircle,
    color: 'text-red-700 dark:text-red-400',
    bg: 'bg-red-500/10 border-red-600 dark:bg-red-400/15 dark:border-red-400/30',
  },
  paused: {
    label: 'Paused',
    icon: Pause,
    color: 'text-yellow-700 dark:text-yellow-400',
    bg: 'bg-yellow-500/10 border-yellow-700 dark:bg-yellow-400/15 dark:border-yellow-400/30',
  },
};
