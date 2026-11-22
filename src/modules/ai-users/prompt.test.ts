import { describe, expect, test } from 'bun:test';
import { parseAiUserPrompt, serializeAiUserPrompt } from './prompt.js';
import {
  canAdvancePersonaDiscussion,
  finishPersonaEmoteTurn,
  inspectPersonaToolCompletion,
  parseTalkingStickDecision,
  PersonaSelfAttributionStreamParser,
  reinstateAddressedPersona,
  resolvePersonaMention,
  resolvePersonaTriggerAttribution,
  runContinuousAiUserTurns,
  type AiUserTurnMessage,
} from './orchestrator.js';
import { TalkingStickStreamParser } from './talking-stick.js';

describe('persona trigger attribution', () => {
  test('retains the initiating human for web turns and marks public turns', () => {
    expect(
      resolvePersonaTriggerAttribution({
        triggeredByUserId: 'human-1',
        triggerSource: 'user',
      }),
    ).toEqual({ triggeredByUserId: 'human-1', triggerSource: 'user' });
    expect(
      resolvePersonaTriggerAttribution({
        publicVisitor: {},
        triggeredByUserId: 'project-owner',
      }),
    ).toEqual({ triggeredByUserId: null, triggerSource: 'public' });
  });
});

describe('AI user prompt frontmatter', () => {
  test('rejects invalid identity, turn, and tools', () => {
    expect(() => parseAiUserPrompt('Body')).toThrow(
      'requires YAML frontmatter',
    );
    expect(() => parseAiUserPrompt('---\nturn: after\n---\nBody')).toThrow(
      'identity is required',
    );
    expect(() =>
      parseAiUserPrompt('---\nidentity: Luna\nturn: middle\n---\nBody'),
    ).toThrow('turn must be');
    expect(() =>
      parseAiUserPrompt('---\nidentity: Luna\ntools: [no-such-set]\n---\nBody'),
    ).toThrow('Unknown toolset');
  });

  test('round-trips the managed format', () => {
    const value = {
      identity: 'Researcher Luna',
      turn: 'after' as const,
      tools: ['web', 'advanced'],
      body: 'Be precise.',
    };
    expect(parseAiUserPrompt(serializeAiUserPrompt(value))).toEqual(value);
  });
});

describe('talking stick decisions', () => {
  test('distinguishes tool-only persona runs from runs with final prose', () => {
    const tool = JSON.stringify({
      type: 'tool_call',
      id: 'call-1',
      status: 'completed',
      name: 'peek_files',
      output: 'files',
    });
    const prose = JSON.stringify({
      type: 'message',
      id: 'msg-1',
      role: 'assistant',
      content: 'Here is what I found.',
      status: 'completed',
    });
    expect(inspectPersonaToolCompletion(tool)).toEqual({
      usedTools: true,
      hasFinalAssistantProse: false,
    });
    expect(inspectPersonaToolCompletion(`${tool}\n${prose}`)).toEqual({
      usedTools: true,
      hasFinalAssistantProse: true,
    });
    expect(inspectPersonaToolCompletion(`${prose}\n${tool}`)).toEqual({
      usedTools: true,
      hasFinalAssistantProse: false,
    });
    expect(
      inspectPersonaToolCompletion(
        JSON.stringify({
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'peek_files',
            state: { status: 'running' },
          },
        }),
      ),
    ).toEqual({ usedTools: false, hasFinalAssistantProse: false });
    expect(inspectPersonaToolCompletion(`not json\n${prose}`)).toEqual({
      usedTools: false,
      hasFinalAssistantProse: true,
    });
  });

  test('strips and parses coordinator control metadata', () => {
    expect(
      parseTalkingStickDecision('Visible reply\n<!-- talking-stick: stop -->'),
    ).toEqual({
      content: 'Visible reply',
      decision: { kind: 'stop' },
    });
    expect(
      parseTalkingStickDecision('Reply\n<!-- talking-stick: ai:persona-1 -->')
        .decision,
    ).toEqual({ kind: 'select', aiUserId: 'persona-1' });
    expect(
      parseTalkingStickDecision(
        'Reply\n<!-- talking-stick: Researcher Luna -->',
      ),
    ).toEqual({
      content: 'Reply',
      decision: { kind: 'select', personaName: 'Researcher Luna' },
    });
  });

  test('defaults to pass when a runtime omits the marker', () => {
    expect(parseTalkingStickDecision('Visible reply')).toEqual({
      content: 'Visible reply',
      decision: { kind: 'pass' },
    });
  });

  test('never exposes a talking-stick marker split across stream chunks', () => {
    const parser = new TalkingStickStreamParser();
    expect(parser.push('Visible reply\n<')).toBe('Visible reply\n');
    expect(parser.push('!-- talking-')).toBe('');
    expect(parser.push('stick: pass -->')).toBe('');
    expect(parser.finish()).toBe('');
  });

  test('never exposes an exact-name handoff split across stream chunks', () => {
    const parser = new TalkingStickStreamParser();
    expect(parser.push('Visible reply\n<!-- talking-stick: Researcher')).toBe(
      'Visible reply\n',
    );
    expect(parser.push(' Luna -->')).toBe('');
    expect(parser.finish()).toBe('');
  });

  test('keeps passing turns until the human stop predicate changes', async () => {
    const decisions: string[] = [];
    let rounds = 0;
    await runContinuousAiUserTurns({
      initialContext: 'Main response',
      initialDecision: { kind: 'select', aiUserId: 'persona-1' },
      shouldStop: () => rounds === 3,
      runRound: async (_context, decision) => {
        decisions.push(decision.kind);
        rounds++;
        return [
          {
            sender_name: 'Persona',
            content: `round ${rounds}`,
          } as AiUserTurnMessage,
        ];
      },
    });
    expect(rounds).toBe(3);
    expect(decisions).toEqual(['select', 'pass', 'pass']);
  });

  test('includes the full participant discussion in each subsequent handoff', async () => {
    const contexts: string[] = [];
    let rounds = 0;
    await runContinuousAiUserTurns({
      initialContext: 'Main response',
      initialDecision: { kind: 'pass' },
      shouldStop: () => rounds === 2,
      runRound: async (context) => {
        contexts.push(context);
        rounds++;
        return [
          {
            sender_name: `Persona ${rounds}`,
            content: `round ${rounds}`,
          } as AiUserTurnMessage,
        ];
      },
    });
    expect(contexts).toEqual([
      'Main response',
      'Main response\n\nPersona 1: round 1',
    ]);
  });

  test('starts a fresh handoff context after a human interruption', async () => {
    const contexts: string[] = [];
    let rounds = 0;
    await runContinuousAiUserTurns({
      initialContext: 'Old discussion',
      initialDecision: { kind: 'pass' },
      shouldStop: () => rounds === 2,
      runRound: async (context) => {
        contexts.push(context);
        rounds++;
        return rounds === 1
          ? {
              messages: [
                {
                  sender_name: 'Persona',
                  content: 'New-topic answer',
                } as AiUserTurnMessage,
              ],
              resetContext: true,
            }
          : [
              {
                sender_name: 'Main',
                content: 'Follow-up',
              } as AiUserTurnMessage,
            ];
      },
    });
    expect(contexts).toEqual(['Old discussion', 'Persona: New-topic answer']);
  });

  test('exits when no active persona can complete a round', async () => {
    let rounds = 0;
    await runContinuousAiUserTurns({
      initialContext: 'Main response',
      initialDecision: { kind: 'pass' },
      shouldStop: () => false,
      runRound: async () => {
        rounds++;
        return [];
      },
    });
    expect(rounds).toBe(1);
  });

  test('rechecks one admitted human prompt before closing the final boundary', async () => {
    let rounds = 0;
    let admittedBeforeClose = true;
    let finishChecks = 0;
    await runContinuousAiUserTurns({
      initialContext: 'Main response',
      initialDecision: { kind: 'pass' },
      shouldStop: () => false,
      beforeFinish: async () => {
        finishChecks++;
        if (!admittedBeforeClose) return false;
        admittedBeforeClose = false;
        return true;
      },
      runRound: async () => {
        rounds++;
        return [];
      },
    });
    expect(rounds).toBe(2);
    expect(finishChecks).toBe(2);
  });

  test('lets timers run while a stopped run keeps being held open', async () => {
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);
    let finishChecks = 0;
    const result = await runContinuousAiUserTurns({
      initialContext: 'Main response',
      initialDecision: { kind: 'pass' },
      shouldStop: () => true,
      beforeFinish: async () => {
        finishChecks++;
        return !timerFired && finishChecks < 1000;
      },
      runRound: async () => [],
    });
    expect(result).toBe('stopped');
    expect(timerFired).toBe(true);
    expect(finishChecks).toBeLessThan(1000);
  });

  test('does not generate the next turn before acknowledged playback', async () => {
    let rounds = 0;
    const events: string[] = [];
    let releaseCurrent!: () => void;
    const currentPlayback = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const running = runContinuousAiUserTurns({
      initialContext: 'Main response',
      initialMessageId: 'main-1',
      initialDecision: { kind: 'pass' },
      shouldStop: () => rounds === 1,
      waitForPlayback: async (messageId) => {
        expect(messageId).toBe('main-1');
        await currentPlayback;
        events.push('playback-acknowledged');
      },
      runRound: async () => {
        rounds++;
        events.push('round');
        return [
          {
            id: `turn-${rounds}`,
            sender_name: 'Persona',
            content: `round ${rounds}`,
          } as AiUserTurnMessage,
        ];
      },
    });
    releaseCurrent();
    await running;
    expect(rounds).toBe(1);
    expect(events).toEqual(['playback-acknowledged', 'round']);
  });

  test('hands the stick to the last unambiguous persona name', () => {
    const personas = [
      {
        id: 'main',
        identity: 'Moderator Maya',
        handoff: { kind: 'main' } as const,
      },
      {
        id: 'luna',
        identity: 'Researcher Luna',
        handoff: { kind: 'select', aiUserId: 'luna' } as const,
      },
      {
        id: 'omar',
        identity: 'Omar',
        handoff: { kind: 'select', aiUserId: 'omar' } as const,
      },
    ];
    expect(
      resolvePersonaMention('Luna, could you respond after Omar?', personas),
    ).toEqual({ kind: 'select', aiUserId: 'omar' });
    expect(
      resolvePersonaMention('What do you think, Moderator Maya?', personas),
    ).toEqual({ kind: 'main' });
  });

  test('does not use an ambiguous first-name shorthand', () => {
    const personas = [
      {
        id: 'a',
        identity: 'Alex Brown',
        handoff: { kind: 'select', aiUserId: 'a' } as const,
      },
      {
        id: 'b',
        identity: 'Alex Green',
        handoff: { kind: 'select', aiUserId: 'b' } as const,
      },
    ];
    expect(
      resolvePersonaMention('Alex, please answer.', personas),
    ).toBeUndefined();
    expect(
      resolvePersonaMention('Alex Green, please answer.', personas),
    ).toEqual({ kind: 'select', aiUserId: 'b' });
  });

  test('carries a named handoff into the next autonomous round', async () => {
    const decisions: string[] = [];
    let rounds = 0;
    await runContinuousAiUserTurns({
      initialContext: 'Main response',
      initialDecision: { kind: 'pass' },
      shouldStop: () => rounds === 2,
      runRound: async (_context, decision) => {
        decisions.push(
          decision.kind === 'select'
            ? `${decision.kind}:${decision.aiUserId}`
            : decision.kind,
        );
        rounds++;
        return {
          messages: [
            {
              sender_name: 'Persona',
              content: `round ${rounds}`,
            } as AiUserTurnMessage,
          ],
          nextDecision:
            rounds === 1 ? { kind: 'select', aiUserId: 'luna' } : undefined,
        };
      },
    });
    expect(decisions).toEqual(['pass', 'select:luna']);
  });

  test('stops after every active participant skips once', async () => {
    let rounds = 0;
    const outcome = await runContinuousAiUserTurns({
      initialContext: 'Main response',
      initialDecision: { kind: 'pass' },
      activeParticipantIds: ['main', 'luna'],
      shouldStop: () => false,
      runRound: async () => {
        rounds++;
        return rounds === 1
          ? {
              messages: [],
              nextDecision: { kind: 'main' },
              skipped: true,
              skippedBy: ['luna'],
            }
          : {
              messages: [],
              nextDecision: { kind: 'pass' },
              skipped: true,
              skippedBy: ['main'],
            };
      },
    });
    expect(outcome).toBe('all-skipped');
    expect(rounds).toBe(2);
  });

  test('a spoken contribution resets the unanimous-skip cycle', async () => {
    let rounds = 0;
    const outcome = await runContinuousAiUserTurns({
      initialContext: 'Main response',
      initialDecision: { kind: 'pass' },
      activeParticipantIds: ['main', 'luna'],
      shouldStop: () => rounds === 4,
      runRound: async () => {
        rounds++;
        if (rounds === 1 || rounds === 3) {
          return { messages: [], skipped: true, skippedBy: ['luna'] };
        }
        return [
          {
            id: `main-${rounds}`,
            sender_name: 'Main',
            content: 'Still useful',
          } as AiUserTurnMessage,
        ];
      },
    });
    expect(outcome).toBe('stopped');
    expect(rounds).toBe(4);
  });

  test('lets the default agent hand its completed turn to one newly invited persona once', () => {
    // Behavioral replacement for the former Live Mode source contract.
    expect(canAdvancePersonaDiscussion(['luna'], undefined, true)).toBe(true);
    expect(canAdvancePersonaDiscussion(['luna'], undefined, false)).toBe(false);
    expect(canAdvancePersonaDiscussion(['main', 'luna'], 'main', false)).toBe(
      true,
    );
    // Main withdrew with a stop marker: the invite still answers the human once.
    expect(canAdvancePersonaDiscussion(['luna'], 'main', true, false)).toBe(
      true,
    );
    expect(canAdvancePersonaDiscussion(['luna'], 'main', false)).toBe(false);
  });

  test('gives main one closing turn after the first invited reply', () => {
    // Loop off: without the owed closing turn the invited reply goes unread.
    expect(
      canAdvancePersonaDiscussion(['main', 'luna'], 'main', false, false),
    ).toBe(false);
    expect(
      canAdvancePersonaDiscussion(['main', 'luna'], 'main', false, false, true),
    ).toBe(true);
    // Main withdrew with stop: the remaining invite alone has no quorum.
    expect(canAdvancePersonaDiscussion(['luna'], 'main', false, true)).toBe(
      false,
    );
    expect(
      canAdvancePersonaDiscussion(['luna'], 'main', false, true, true),
    ).toBe(true);
  });
});

describe('persona emote markers', () => {
  test('withholds and strips a persona self-attribution split across stream chunks', () => {
    const parser = new PersonaSelfAttributionStreamParser({
      name: 'Bulă',
      identity: 'poznașul din bancurile românești',
    });
    expect(parser.push('[Persona poznașul din ')).toBe('');
    expect(parser.push('bancurile românești]')).toBe('');
    expect(parser.push(': Alinuța este aici, ')).toBe('Alinuța este aici, ');
    expect(parser.push('iar eu sunt Bulă.')).toBe('iar eu sunt Bulă.');
    expect(parser.finish()).toBe('');
  });

  test('releases ordinary streamed prose as soon as attribution is ruled out', () => {
    const parser = new PersonaSelfAttributionStreamParser({
      name: 'Bulă',
      identity: 'poznașul din bancurile românești',
    });
    expect(parser.push('— De ce a pus badea routerul în coteț?')).toBe(
      '— De ce a pus badea routerul în coteț?',
    );
    expect(parser.push('\n— Ca să aibă găinile Wi-Fi.')).toBe(
      '\n— Ca să aibă găinile Wi-Fi.',
    );
  });

  test('selects an available emote and strips the marker', () => {
    expect(
      finishPersonaEmoteTurn(
        'That is wonderful!\n<!-- persona-emote:Very Happy -->',
        ['very-happy', 'sad'],
      ),
    ).toEqual({
      content: 'That is wonderful!',
      speechText: 'That is wonderful!',
      emote: 'very-happy',
    });
  });

  test('preserves invited-persona Markdown line structure for transcript replay', () => {
    const content = [
      'Opening paragraph.',
      '',
      '- First point',
      '- Second point',
      '',
      'Closing paragraph.',
      '<!-- persona-emote:happy -->',
    ].join('\n');
    expect(finishPersonaEmoteTurn(content, ['happy']).content).toBe(
      [
        'Opening paragraph.',
        '',
        '- First point',
        '- Second point',
        '',
        'Closing paragraph.',
      ].join('\n'),
    );
  });
});

describe('persona speech expressions', () => {
  test('keeps approved expressions only in speech text', () => {
    const result = finishPersonaEmoteTurn(
      'Well <!-- persona-expression:sigh --> okay <!-- persona-expression:laugh -->! <!-- persona-emote:happy -->',
      ['happy'],
    );
    expect(result.content).toBe('Well okay !');
    expect(result.speechText).toBe('Well <sigh> okay <laugh> !');
    expect(result.emote).toBe('happy');
  });

  test('drops unknown, raw, and excessive expressions', () => {
    const result = finishPersonaEmoteTurn(
      '<laugh> A <!-- persona-expression:laugh --> B <!-- persona-expression:breath --> C <!-- persona-expression:sigh --> D <!-- persona-expression:laugh --> E <!-- persona-expression:whisper -->',
      [],
    );
    expect(result.content).toBe('A B C D E');
    expect(result.speechText).toBe('A <laugh> B <breath> C <sigh> D E');
  });
});

describe('withdrawn persona wake-up', () => {
  test('a name handoff wakes a withdrawn main or invite', () => {
    const stopped = new Set(['main', 'luna']);
    reinstateAddressedPersona(stopped, { kind: 'main' }, 'main', 'mike');
    reinstateAddressedPersona(
      stopped,
      { kind: 'select', aiUserId: 'luna' },
      'main',
      'mike',
    );
    expect([...stopped]).toEqual([]);
  });

  test('pass, stop and self-handoff keep withdrawals', () => {
    const stopped = new Set(['main', 'mike']);
    reinstateAddressedPersona(stopped, { kind: 'pass' }, 'main', 'mike');
    reinstateAddressedPersona(stopped, { kind: 'stop' }, 'main', 'mike');
    reinstateAddressedPersona(
      stopped,
      { kind: 'select', aiUserId: 'mike' },
      'main',
      'mike',
    );
    expect([...stopped]).toEqual(['main', 'mike']);
  });
});
