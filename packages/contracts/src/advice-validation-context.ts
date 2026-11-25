import { z } from 'zod';
import { ScenarioSchema } from './conversation-state';

export const SourceMessageSchema = z
  .object({
    id: z.string().min(1),
    role: z.literal('user'),
    text: z.string().min(1).max(500),
  })
  .strict();

export const AdviceValidationContextSchema = z
  .object({
    sessionId: z.string().min(1),
    revision: z.number().int().positive(),
    activeScenario: ScenarioSchema,
    pendingFields: z.array(z.string()).max(32),
    sourceMessages: z.array(SourceMessageSchema).max(8),
  })
  .strict();

export type AdviceValidationContext = z.infer<
  typeof AdviceValidationContextSchema
>;
