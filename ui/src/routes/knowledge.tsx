import { createFileRoute } from '@tanstack/react-router';
import { KnowledgeHub } from '@/components/knowledge/knowledge-hub';

export const Route = createFileRoute('/knowledge')({
  component: KnowledgeHub,
});
