import { useRouter } from 'expo-router';
import { OverviewScreen } from '@/features/overview/overview-screen';
export default function Overview() {
  const router = useRouter();
  return (
    <OverviewScreen
      onWallets={() =>
        router.push({ pathname: '/detail', params: { screen: 'wallets' } })
      }
      onGoals={() =>
        router.push({ pathname: '/detail', params: { screen: 'goals' } })
      }
    />
  );
}
