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
    return (
      <GoalManager
        guardRouteKey="budgets"
        onClose={() => handleSwitchTab('stats')}
      />
    );
  }

  if (activeTab === 'stats') {
    return (
      <StatsView
        onOpenTrend={() =>
          router.push({ pathname: '/detail', params: { screen: 'stats-trend' } })
        }
        onOpenBudgets={() =>
          router.push({ pathname: '/detail', params: { screen: 'budgets' } })
        }
        onOpenCalendar={() =>
          router.push({
            pathname: '/detail',
            params: { screen: 'stats-calendar' },
          })
        }
        onOpenGoals={() =>
          router.push({
            pathname: '/detail',
            params: { screen: 'goals', from: 'budgets' },
          })
        }
      />
    );
  }

  return <BudgetManager onClose={() => handleSwitchTab('stats')} />;
}
