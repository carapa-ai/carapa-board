import { fireEvent, screen } from '@testing-library/react';

/**
 * Open a `Select` (Radix) from its trigger and pick an option by accessible
 * name. Replaces `fireEvent.change`/`userEvent.selectOptions` on the old native
 * `<select>`. The list renders in a portal, so the option is looked up on the
 * whole document.
 */
export async function chooseOption(
  trigger: HTMLElement,
  option: string | RegExp,
): Promise<void> {
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

/** The text a `Select` trigger currently shows (its selected option label). */
export function selectedLabel(trigger: HTMLElement): string {
  return (trigger.textContent ?? '').trim();
}
