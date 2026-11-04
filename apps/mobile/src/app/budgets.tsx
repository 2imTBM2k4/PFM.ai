import { useLocalSearchParams, useRouter } from 'expo-router';
import { BudgetManager } from '@/features/budgets/budget-manager';
import { StatsView } from '@/features/stats/stats-view';

export default function Budgets() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const router = useRouter();
  const activeTab = tab === 'budgets' ? 'budgets' : 'stats';

  return activeTab === 'stats' ? (
    <StatsView onSwitchToBudgets={() => router.setParams({ tab: 'budgets' })} />
  ) : (
    <BudgetManager onSwitchToStats={() => router.setParams({ tab: 'stats' })} />
  );
}
