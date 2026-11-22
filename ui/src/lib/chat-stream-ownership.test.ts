// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { mainResponseOwner } from './chat-stream-ownership';

describe('main response ownership', () => {
  it('never exposes the generic owner for an unpersisted Persona Live turn', () => {
    expect(
      mainResponseOwner({
        personaDriven: true,
        hasVirtualSender: true,
        mainPersonaIsVoiceDelayed: true,
        hasPersistedResponse: false,
        chatRunning: true,
        sending: true,
        streamIsActive: true,
      }),
    ).toBe('canonical-transcript');
  });

  it('keeps a persisted configured main persona in the transcript during handoff', () => {
    expect(
      mainResponseOwner({
        personaDriven: true,
        hasVirtualSender: true,
        mainPersonaIsVoiceDelayed: true,
        hasPersistedResponse: true,
        chatRunning: true,
        sending: true,
        streamIsActive: true,
      }),
    ).toBe('canonical-transcript');
  });

  it('retains generic ownership for the unnamed agent handoff', () => {
    expect(
      mainResponseOwner({
        personaDriven: true,
        hasVirtualSender: false,
        chatRunning: true,
        sending: true,
        streamIsActive: true,
      }),
    ).toBe('generic-stream');
  });
});
