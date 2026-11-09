import * as Crypto from 'expo-crypto';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';
import { BottomSheetModal } from '@/components/ui/bottom-sheet-modal';
import { withDatabase } from '@/data/connection';
import { listCategories, type CategoryRow } from '@/data/categories';
import { listWallets, type WalletRow } from '@/data/repository';
import { createTransaction } from '@/data/transactions';
import type { TransactionInput } from '@pfm/contracts';
import { checkBudgetAlerts } from '@/features/budgets/mobile';
import { vi } from '@/messages/vi';
import { useApp } from '@/state/app';
import { usePreferences } from '@/state/preferences';
import { TransactionForm } from './transaction-manager';

export interface AddTransactionModalProps {
  onSaved?(): void;
}

export function AddTransactionModal({ onSaved }: AddTransactionModalProps) {
  const visible = usePreferences((state) => state.isAddTransactionOpen);
  const close = usePreferences((state) => state.closeAddTransaction);

  const [wallets, setWallets] = useState<WalletRow[] | null>(null);
  const [categories, setCategories] = useState<CategoryRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loading = visible && (wallets === null || categories === null);

  useEffect(() => {
    if (!visible) {
      return;
    }
    let active = true;
    void Promise.all([
      withDatabase(listWallets),
      withDatabase(listCategories),
    ])
      .then(([w, c]) => {
        if (!active) return;
        setWallets(w);
        setCategories(c);
      })
      .catch(() => {
        if (!active) return;
        setError(vi.databaseError);
        setWallets([]);
        setCategories([]);
      });
    return () => {
      active = false;
    };
  }, [visible]);

  const handleSave = async (input: TransactionInput) => {
    setBusy(true);
    setError('');
    try {
      const newId = Crypto.randomUUID();
      await withDatabase((db) =>
        createTransaction(db, newId, input, new Date().toISOString()),
      );
      void useApp.getState().refreshWallets();
      useApp.setState((s) => ({ recurringVersion: s.recurringVersion + 1 }));
      void checkBudgetAlerts();
      close();
      onSaved?.();
    } catch {
      setError(vi.databaseError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheetModal
      visible={visible}
      onClose={close}
      title={vi.addTransaction}
      subtitle={vi.quickAddManual}
      maxHeightPercent={0.92}
    >
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" />
          <Text style={{ marginTop: 8 }}>{vi.loading}</Text>
        </View>
      ) : (
        <TransactionForm
          row={null}
          wallets={wallets ?? []}
          categories={categories ?? []}
          busy={busy}
          error={error}
          onBack={close}
          hideHeader={true}
          onNaturalSaved={async () => {
            void useApp.getState().refreshWallets();
            useApp.setState((s) => ({ recurringVersion: s.recurringVersion + 1 }));
            void checkBudgetAlerts();
            close();
            onSaved?.();
          }}
          onSave={handleSave}
        />
      )}
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
});
