import { expect, it } from 'vitest';
import { publishChatCommit } from './commit';
import { mergeChatMessages } from './history';
import type { ChatRow } from '@/data/repository';

it('publishes a completed save and clears the input after tab blur, without refreshing the hidden screen', async () => {
  const lifetime = { mounted: true, focused: true };
  let input = 'question';
  let messages: ChatRow[] = [];
  let refreshed = false;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const save = (async () => {
    await pending;
    await publishChatCommit(
      lifetime,
      () => {
        messages = mergeChatMessages(messages, [
          { id: 'one', text: input, created_at: 'now' },
        ]);
        input = '';
      },
      async () => {
        refreshed = true;
      },
    );
  })();
  lifetime.focused = false;
  finish();
  await save;
  expect(input).toBe('');
  expect(messages.map((message) => message.text)).toEqual(['question']);
  expect(refreshed).toBe(false);
});

it('removes an undone message while the tab is hidden', async () => {
  let messages: ChatRow[] = [{ id: 'one', text: 'entry', created_at: 'now' }];
  await publishChatCommit({ mounted: true, focused: false }, () => {
    messages = messages.filter((message) => message.id !== 'one');
  });
  expect(messages).toEqual([]);
});

it('does not publish into an unmounted screen after a delayed write', async () => {
  const lifetime = { mounted: true, focused: true };
  let visible = 'draft';
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const save = (async () => {
    await pending;
    await publishChatCommit(lifetime, () => {
      visible = 'saved';
    });
  })();
  lifetime.mounted = false;
  lifetime.focused = false;
  finish();
  await save;
  expect(visible).toBe('draft');
});

it('publishes the committed result before a visible-screen refresh fails', async () => {
  let input = 'draft';
  await expect(
    publishChatCommit(
      { mounted: true, focused: true },
      () => {
        input = '';
      },
      async () => {
        throw new Error('REFRESH_FAILED');
      },
    ),
  ).rejects.toThrow('REFRESH_FAILED');
  expect(input).toBe('');
});
