import type { PropsWithChildren } from 'react';

/** Native passthrough: iOS and Android keep the mobile tab bar and stack layout unchanged. */
export function WebDashboardShell({ children }: PropsWithChildren) {
  return <>{children}</>;
}
