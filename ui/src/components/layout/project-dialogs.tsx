import { AddTaskDialog } from '@/components/board/add-task-dialog';
import { AddCronjobDialog } from '@/components/board/add-cronjob-dialog';
import { EditCronjobDialog } from '@/components/board/edit-cronjob-dialog';
import { AddDatasetTaskDialog } from '@/components/board/add-dataset-task-dialog';
import { EditDatasetTaskDialog } from '@/components/board/edit-dataset-task-dialog';
import { TaskDetailDialog } from '@/components/board/task-detail-dialog';

interface ProjectDialogsProps {
  project_id: string;
}

export function ProjectDialogs({ project_id }: ProjectDialogsProps) {
  return (
    <>
      <AddTaskDialog project_id={project_id} />
      <AddCronjobDialog project_id={project_id} />
      <EditCronjobDialog project_id={project_id} />
      <AddDatasetTaskDialog project_id={project_id} />
      <EditDatasetTaskDialog project_id={project_id} />
      <TaskDetailDialog project_id={project_id} />
    </>
  );
}
