import { getConfigurableToolsets } from '../tools/registry.js';
import type { AiUserPrompt, AiUserTurn } from './types.js';

function unquote(value: string): string {
  return value.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
}

/** Parse the deliberately small frontmatter format used by AI-user prompts. */
export function parseAiUserPrompt(content: string): AiUserPrompt {
  const match = content.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/,
  );
  if (!match) throw new Error('AI user prompt requires YAML frontmatter');

  let identity = '';
  let turn: AiUserTurn = 'after';
  const tools: string[] = [];
  const lines = match[1].split(/\r?\n/);
  let inTools = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (inTools && line.startsWith('-')) {
      const toolset = unquote(line.slice(1));
      if (!toolset) throw new Error('tools entries must be non-empty strings');
      tools.push(toolset);
      continue;
    }
    inTools = false;
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1));
    if (key === 'identity') identity = value;
    else if (key === 'turn') {
      if (value !== 'before' && value !== 'after')
        throw new Error('turn must be "before" or "after"');
      turn = value;
    } else if (key === 'tools') {
      inTools = true;
      if (value) {
        if (!value.startsWith('[') || !value.endsWith(']'))
          throw new Error('tools must be a YAML list');
        const inline = value.slice(1, -1).trim();
        if (inline) tools.push(...inline.split(',').map(unquote));
        inTools = false;
      }
    } else {
      throw new Error(`Unknown AI user frontmatter field "${key}"`);
    }
  }

  if (!identity.trim())
    throw new Error('identity is required in AI user frontmatter');
  // Saved prompts may still name the retired WhatsApp toolset "advanced".
  // Preserve it for editing and session fingerprints; runtime
  // access is separately filtered by resolveAllowedPersonaTools.
  const knownToolsets = new Set([...getConfigurableToolsets(), 'advanced']);
  for (const toolset of tools) {
    if (!knownToolsets.has(toolset))
      throw new Error(`Unknown toolset "${toolset}"`);
  }
  return {
    identity: identity.trim(),
    turn,
    tools: [...new Set(tools)],
    body: match[2].trim(),
  };
}

export function serializeAiUserPrompt(input: AiUserPrompt): string {
  const tools =
    input.tools.length > 0
      ? `tools:\n${input.tools.map((tool) => `  - ${tool}`).join('\n')}`
      : 'tools: []';
  return `---\nidentity: ${JSON.stringify(input.identity)}\nturn: ${input.turn}\n${tools}\n---\n\n${input.body.trim()}\n`;
}
