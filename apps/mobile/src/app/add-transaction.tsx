import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { AddTransactionModal } from '@/features/transactions/add-transaction-modal';
import { NativeRouteGuard } from '@/components/native-route-guard';
import { usePreferences } from '@/state/preferences';

/** Hosts the existing transaction form in a native form sheet. */
export default function AddTransaction() {
  const router = useRouter();
  useEffect(() => () => usePreferences.getState().closeAddTransaction(), []);
  return (
    <>
      <NativeRouteGuard scope="modal" />
      <AddTransactionModal onClose={() => router.back()} />
    </>
  );
}
