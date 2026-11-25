import { useRouter } from 'expo-router';
import { TransactionManager } from '@/features/transactions/transaction-manager';
export default function Transactions() {
  const router = useRouter();
  return (
    <TransactionManager
      onManageRecurring={() =>
        router.push({ pathname: '/detail', params: { screen: 'recurring' } })
      }
      onManageDebts={() =>
        router.push({ pathname: '/detail', params: { screen: 'debts' } })
      }
    />
  );
}
