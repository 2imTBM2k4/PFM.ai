import { useLocalSearchParams, useRouter } from 'expo-router';
import { BudgetManager } from '@/features/budgets/budget-manager';
import { GoalManager } from '@/features/goals/goal-manager';
import { StatsView } from '@/features/stats/stats-view';

export type BudgetTabType = 'stats' | 'budgets' | 'goals';

export default function Budgets() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const router = useRouter();
  const activeTab: BudgetTabType =
    tab === 'budgets' ? 'budgets' : tab === 'goals' ? 'goals' : 'stats';

  const handleSwitchTab = (newTab: BudgetTabType) => {
    router.setParams({ tab: newTab });
  };

  if (activeTab === 'goals') {
    return <GoalManager guardRouteKey="budgets" onSwitchTab={handleSwitchTab} />;
  }

  if (activeTab === 'stats') {
    return (
      <StatsView
        onSwitchTab={handleSwitchTab}
        onSwitchToBudgets={() => handleSwitchTab('budgets')}
      />
    );
  }

  return (
    <BudgetManager
      onSwitchTab={handleSwitchTab}
      onSwitchToStats={() => handleSwitchTab('stats')}
    />
  );
}
