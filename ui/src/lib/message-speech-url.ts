import { API_BASE_URL } from './api-config';

export function messageSpeechUrl(
  projectId: string,
  conversationId: string,
  messageId: string,
): string {
  return `${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/speech`;
}
