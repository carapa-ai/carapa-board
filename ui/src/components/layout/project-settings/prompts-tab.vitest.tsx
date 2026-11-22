import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { ProjectSettings } from '@/types';
import { PromptsTab } from './prompts-tab';

afterEach(cleanup);

function Harness({ initial }: { initial: ProjectSettings }) {
  const [form, setForm] = useState<ProjectSettings>(initial);
  return (
    <Tabs defaultValue="prompts">
      <PromptsTab
        form={form}
        setForm={setForm}
        project_id="p"
        savedProjectIsParent={false}
        savedProjectUsesRepositoryPrompt={false}
        regenerating={false}
        setRegenerating={() => {}}
      />
      <output data-testid="form">{JSON.stringify(form)}</output>
    </Tabs>
  );
}

describe('PromptsTab', () => {
  it('serializes an empty starterPrompts array after removing the last prompt', () => {
    render(
      <Harness
        initial={{ starterPrompts: [{ label: 'One', prompt: 'Do one' }] }}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove starter prompt 1' }),
    );
    expect(screen.getByTestId('form').textContent).toContain(
      '"starterPrompts":[]',
    );
  });

  it('keeps focus on the chat-mode ID input while typing', () => {
    render(<Harness initial={{ chatModes: [{ id: 'a', label: 'A' }] }} />);
    const input = screen.getAllByPlaceholderText('mode id')[0];
    input.focus();
    for (const value of ['ab', 'abc']) {
      fireEvent.change(document.activeElement ?? input, { target: { value } });
    }
    const after = screen.getAllByPlaceholderText(
      'mode id',
    )[0] as HTMLInputElement;
    expect(after).toBe(input);
    expect(after.value).toBe('abc');
    expect(document.activeElement).toBe(input);
  });

  it('keeps a mode prompt attached when its id is cleared and retyped', () => {
    render(
      <Harness
        initial={{
          chatModes: [{ id: 'plan', label: 'Plan' }],
          chatModePrompts: { plan: 'X' },
        }}
      />,
    );
    const idInput = screen.getByRole('textbox', { name: 'Mode id for Plan' });
    fireEvent.change(idInput, { target: { value: '' } });
    expect(
      (screen.getByPlaceholderText(/Prompt override/) as HTMLTextAreaElement)
        .value,
    ).toBe('X');
    fireEvent.change(idInput, { target: { value: 'p' } });
    fireEvent.change(idInput, { target: { value: 'planner' } });
    expect(
      (screen.getByPlaceholderText(/Prompt override/) as HTMLTextAreaElement)
        .value,
    ).toBe('X');
    const form = JSON.parse(screen.getByTestId('form').textContent ?? '{}');
    expect(form.chatModePrompts).toEqual({ planner: 'X' });
  });

  it('reports an empty or duplicate chat-mode id and names remove buttons', () => {
    render(
      <Harness
        initial={{
          chatModes: [
            { id: 'plan', label: 'Plan' },
            { id: 'code', label: 'Code' },
          ],
          chatModePrompts: { plan: 'P', code: 'C' },
        }}
      />,
    );
    expect(
      screen.getByRole('button', { name: /remove mode plan/i }),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const codeId = screen.getByRole('textbox', { name: 'Mode id for Code' });
    fireEvent.change(codeId, { target: { value: 'plan' } });
    expect(screen.getByRole('alert').textContent).toContain('used twice');
    fireEvent.change(codeId, { target: { value: '' } });
    expect(screen.getByRole('alert').textContent).toContain('needs an id');
    fireEvent.change(codeId, { target: { value: 'review' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      JSON.parse(screen.getByTestId('form').textContent ?? '{}')
        .chatModePrompts,
    ).toEqual({ plan: 'P', review: 'C' });
  });

  it('keeps each row prompt through cross-row id swaps and conflicts', () => {
    render(
      <Harness
        initial={{
          chatModes: [
            { id: 'plan', label: 'Plan' },
            { id: 'code', label: 'Code' },
          ],
          chatModePrompts: { plan: 'P', code: 'C' },
        }}
      />,
    );
    const prompts = () =>
      JSON.parse(screen.getByTestId('form').textContent ?? '{}')
        .chatModePrompts;
    // Plan takes Code's id, then Code moves away: ids are valid again.
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Mode id for Plan' }),
      {
        target: { value: 'code' },
      },
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Mode id for Code' }),
      {
        target: { value: 'review' },
      },
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(prompts()).toEqual({ code: 'P', review: 'C' });
    // Clearing one id then reusing it on another row must not clobber its prompt.
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Mode id for Plan' }),
      {
        target: { value: '' },
      },
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Mode id for Code' }),
      {
        target: { value: 'code' },
      },
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Mode id for Plan' }),
      {
        target: { value: 'plan' },
      },
    );
    expect(prompts()).toEqual({ plan: 'P', code: 'C' });
    // Removing the conflicting row leaves the survivor's prompt intact.
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Mode id for Plan' }),
      {
        target: { value: 'code' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: /remove mode plan/i }));
    expect(prompts()).toEqual({ code: 'C' });
  });

  it('keeps default-mode prompts editable after removing the last mode', () => {
    render(
      <Harness
        initial={{
          chatModes: [{ id: 'plan', label: 'Plan' }],
          chatModePrompts: { plan: 'P' },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove mode plan/i }));
    fireEvent.change(screen.getAllByPlaceholderText(/Prompt override/)[0], {
      target: { value: 'edited' },
    });
    const form = JSON.parse(screen.getByTestId('form').textContent ?? '{}');
    expect(form.chatModePrompts).toEqual({ ask: 'edited' });
    expect(
      (
        screen.getAllByPlaceholderText(
          /Prompt override/,
        )[0] as HTMLTextAreaElement
      ).value,
    ).toBe('edited');
  });
});
