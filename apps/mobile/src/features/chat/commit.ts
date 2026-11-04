// Publish committed state independently from visible-screen refresh work.
export async function publishChatCommit(
  lifetime: { mounted: boolean; focused: boolean },
  publish: () => void,
  refresh?: () => Promise<void>,
): Promise<void> {
  if (!lifetime.mounted) return;
  publish();
  if (lifetime.focused) await refresh?.();
}
