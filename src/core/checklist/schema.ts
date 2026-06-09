import { z } from 'zod';
import { TASK_ID_RE } from '../manifest/schema.js';

export const taskStatusSchema = z.union([z.literal('pending'), z.literal('done')]);

export const checklistTaskSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(TASK_ID_RE, 'task id must be kebab-case ([a-z0-9-], no leading/trailing dash)'),
  title: z.string().min(1),
  // M14.7: tasks remember their `run` / `open` declarations so the
  // interactive `hex setup` picker and `hex doctor` can offer the
  // executor actions without re-reading the manifest.
  run: z.string().min(1).optional(),
  open: z.string().min(1).optional(),
  detail: z.string().optional(),
  status: taskStatusSchema,
});

export const checklistSchema = z.object({
  tasks: z.array(checklistTaskSchema),
});
