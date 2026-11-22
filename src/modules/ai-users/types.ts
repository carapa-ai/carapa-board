export type AiUserTurn = 'before' | 'after';

export interface AiUserPrompt {
  identity: string;
  turn: AiUserTurn;
  tools: string[];
  body: string;
}
