import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecording } from '@/lib/api';
import { TaskRecordingsList } from './task-detail-dialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
    () => undefined,
  );
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(
    () => undefined,
  );
});

const recordings: TaskRecording[] = Array.from({ length: 120 }, (_, index) => ({
  filename: `recording-${index}.webm`,
  url: `/recordings/recording-${index}.webm`,
  size: 1024 * (index + 1),
  mtime: '2026-08-09T00:00:00.000Z',
}));

function RecordingsHarness() {
  const [available, setAvailable] = useState(recordings);
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null);

  return (
    <TaskRecordingsList
      recordings={available}
      selectedFilename={selectedFilename}
      onSelect={setSelectedFilename}
      onDelete={(filename) => {
        setAvailable((current) =>
          current.filter((recording) => recording.filename !== filename),
        );
        setSelectedFilename((selected) =>
          selected === filename ? null : selected,
        );
      }}
      deleteDisabled={false}
    />
  );
}

function TaskOwnedRecordingsHarness({ taskId }: { taskId: string }) {
  const [selected, setSelected] = useState<{
    taskId: string;
    filename: string;
  } | null>(null);
  const selectedFilename =
    selected?.taskId === taskId ? selected.filename : null;

  return (
    <TaskRecordingsList
      recordings={[recordings[0]]}
      selectedFilename={selectedFilename}
      onSelect={(filename) =>
        setSelected(filename ? { taskId, filename } : null)
      }
      onDelete={() => undefined}
      deleteDisabled={false}
    />
  );
}

describe('TaskRecordingsList', () => {
  it('keeps persisted recordings unloaded until one is explicitly selected', async () => {
    const { container } = render(<RecordingsHarness />);

    expect(
      container.querySelectorAll('[data-ui="task-recording"]'),
    ).toHaveLength(recordings.length);
    expect(container.querySelectorAll('video')).toHaveLength(0);
    expect(container.querySelectorAll('[src]')).toHaveLength(0);

    fireEvent.click(
      container.querySelector<HTMLElement>(
        '[data-ui="task-recording-playback-trigger"][data-recording-filename="recording-7.webm"]',
      )!,
    );

    await waitFor(() =>
      expect(container.querySelectorAll('video')).toHaveLength(1),
    );
    const player = container.querySelector<HTMLVideoElement>(
      '[data-ui="task-recording-player"]',
    );
    expect(player?.dataset.recordingFilename).toBe('recording-7.webm');
    expect(player?.getAttribute('src')).toBe('/recordings/recording-7.webm');
  });

  it('does not carry an explicit selection into another task with the same filename', async () => {
    const { container, rerender } = render(
      <TaskOwnedRecordingsHarness taskId="task-a" />,
    );
    fireEvent.click(
      container.querySelector('[data-ui="task-recording-playback-trigger"]')!,
    );
    await waitFor(() =>
      expect(container.querySelectorAll('video')).toHaveLength(1),
    );

    rerender(<TaskOwnedRecordingsHarness taskId="task-b" />);

    expect(container.querySelectorAll('video')).toHaveLength(0);
  });
});
