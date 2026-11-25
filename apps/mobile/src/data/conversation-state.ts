import {
  ConversationStateSchema,
  type ConversationState,
} from '@pfm/contracts';
import { withDatabase } from './connection';

/** Read local state, leaving absent or unsupported records on the legacy path. */
export function readConversationState(
  sessionId: string,
): Promise<ConversationState | null> {
  return withDatabase(async (db) => {
    const row = await db.getFirstAsync<{
      revision: number;
      state_json: string;
      updated_at: string;
    }>(
      'SELECT revision, state_json, updated_at FROM conversation_states WHERE session_id = ?',
      sessionId,
    );
    if (!row) return null;
    try {
      const state = ConversationStateSchema.parse(JSON.parse(row.state_json));
      if (
        state.sessionId !== sessionId ||
        state.revision !== row.revision ||
        state.updatedAt !== row.updated_at
      ) {
        throw new Error('CONVERSATION_STATE_METADATA_MISMATCH');
      }
      return state;
    } catch {
      // Never log stored facts, source messages, identifiers, or validation input.
      console.warn('CONVERSATION_STATE_INVALID');
      return null;
    }
  });
}

/** Persist facts and slots atomically and return the committed revision. */
export async function writeConversationState(
  input: ConversationState,
  options?: { sourceMessageId: string },
): Promise<ConversationState> {
  const state = ConversationStateSchema.parse(input);
  const next = ConversationStateSchema.parse({
    ...state,
    revision: state.revision + 1,
  });
  await withDatabase((db) =>
    db.transaction(async (tx) => {
      // Initialization must not resurrect a session deleted while the chat turn was in flight.
      if (
        options &&
        !(await tx.getFirstAsync(
          'SELECT id FROM chat_messages WHERE id = ? AND session_id = ?',
          options.sourceMessageId,
          state.sessionId,
        ))
      )
        throw new Error('CONVERSATION_STATE_SOURCE_MISSING');
      const params = [
        next.revision,
        JSON.stringify(next),
        next.updatedAt,
        next.sessionId,
      ] as const;
      const result =
        state.revision === 0
          ? await tx.getFirstAsync<{ revision: number }>(
              'INSERT INTO conversation_states (revision, state_json, updated_at, session_id) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING RETURNING revision',
              ...params,
            )
          : await tx.getFirstAsync<{ revision: number }>(
              'UPDATE conversation_states SET revision = ?, state_json = ?, updated_at = ? WHERE session_id = ? AND revision = ? RETURNING revision',
              ...params,
              state.revision,
            );
      if (!result) throw new Error('CONVERSATION_STATE_CONFLICT');
    }),
  );
  return next;
}

/** Delete only the local state belonging to the supplied session. */
export function deleteConversationState(sessionId: string): Promise<void> {
  return withDatabase(async (db) => {
    await db.runAsync(
      'DELETE FROM conversation_states WHERE session_id = ?',
      sessionId,
    );
  });
}

/** List stored state identifiers without hydrating or creating any state. */
export function listSessionsWithState(): Promise<string[]> {
  return withDatabase(async (db) => {
    const rows = await db.getAllAsync<{ session_id: string }>(
      'SELECT session_id FROM conversation_states ORDER BY session_id',
    );
    return rows.map(({ session_id }) => session_id);
  });
}
