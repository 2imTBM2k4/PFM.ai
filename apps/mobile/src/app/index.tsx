import { useState } from 'react';
import { WalletManager } from '@/features/wallets/wallet-manager';
import { GoalManager } from '@/features/goals/goal-manager';
import { OverviewScreen } from '@/features/overview/overview-screen';

export default function Overview() {
  const [managing, setManaging] = useState(false);
  const [goals, setGoals] = useState(false);
  if (managing) return <WalletManager onClose={() => setManaging(false)} />;
  if (goals) return <GoalManager guardRouteKey="index" onClose={() => setGoals(false)} />;
  return (
    <OverviewScreen
      onWallets={() => setManaging(true)}
      onGoals={() => setGoals(true)}
    />
  );
}
