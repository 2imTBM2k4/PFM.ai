import { BottomSheetModal } from '@/components/ui/bottom-sheet-modal';
import { usePreferences } from '@/state/preferences';
import { vi } from '@/messages/vi';
import Chat from '@/app/chat';

export function AIChatModal() {
  const visible = usePreferences((state) => state.isChatOpen);
  const close = usePreferences((state) => state.closeChat);

  return (
    <BottomSheetModal
      visible={visible}
      onClose={close}
      title={vi.chat}
      subtitle={vi.quickAddAI}
      maxHeightPercent={0.94}
    >
      <Chat isModal={true} onClose={close} />
    </BottomSheetModal>
  );
}
