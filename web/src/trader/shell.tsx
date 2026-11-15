import type { CSSProperties, ReactNode } from 'react';
import {
  ActivityIcon,
  ArrowLeftRightIcon,
  BriefcaseIcon,
  FileTextIcon,
  HistoryIcon,
  LayoutGridIcon,
  PlayIcon,
  RadarIcon,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { NavGroup } from '@/components/nav-group';
import type { SidebarNavGroup } from '@/components/app-shared';
import { CustomSidebarTrigger } from '@/components/custom-sidebar-trigger';
import { StatusIndicator } from '@/components/indicator';
import { cn } from '@/lib/utils';
import { SoftText, SubtleNumber } from './motion';

export const navGroups: SidebarNavGroup[] = [
  { items: [{ title: 'Overview', path: '#overview', icon: <LayoutGridIcon /> }] },
  {
    label: 'Trading',
    items: [
      { title: 'Positions', path: '#positions', icon: <BriefcaseIcon /> },
      { title: 'Transactions', path: '#transactions', icon: <ArrowLeftRightIcon /> },
      { title: 'Completed trades', path: '#completed', icon: <HistoryIcon /> },
    ],
  },
  {
    label: 'Market',
    items: [
      { title: 'Monitored tokens', path: '#tokens', icon: <RadarIcon /> },
      { title: 'Data feeds', path: '#feeds', icon: <ActivityIcon /> },
    ],
  },
];

export type StatusTone = 'emerald' | 'amber' | 'rose' | 'sky';

/** The always-visible reminder that nothing here is real money. */
export function PaperBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full bg-amber-400/10 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap text-amber-300',
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-300" />
      Paper trading
    </span>
  );
}

function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-primary">
        <svg className="size-3.5 text-primary-foreground" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.6" viewBox="0 0 16 16">
          <path d="M3 4.5 8 11.5 13 4.5" />
        </svg>
      </span>
      <span className="text-[13px] font-semibold tracking-[0.14em] group-data-[collapsible=icon]:hidden">VEXTRA</span>
    </span>
  );
}

export function TraderShell({
  children,
  pathname,
  status,
  dataLive,
  solUsd,
  countdown,
  experimentId,
  hasReport,
  canStart,
  onStart,
  loading = false,
}: {
  children: ReactNode;
  pathname: string;
  status: { label: string; tone: StatusTone };
  dataLive: boolean;
  solUsd: number | null;
  countdown: { label: string; detail: string; progress: number; msLeft: number } | null;
  experimentId: number | null;
  hasReport: boolean;
  canStart: boolean;
  onStart: () => void;
  /** No state from the engine yet: hide controls that depend on it. */
  loading?: boolean;
}) {
  const active = navGroups.flatMap((g) => g.items).find((i) => i.path === pathname) ?? navGroups[0].items[0];
  return (
    <SidebarProvider className="h-svh overflow-hidden" style={{ '--sidebar-width': '14rem' } as CSSProperties}>
      <Sidebar className="border-r-0" collapsible="icon" variant="sidebar">
        <SidebarHeader className="h-16 justify-center px-3">
          <SidebarMenuButton asChild className="hover:bg-transparent active:bg-transparent">
            <a aria-label="VEXTRA overview" href="#overview">
              <Logo />
            </a>
          </SidebarMenuButton>
        </SidebarHeader>
        <SidebarContent className="gap-1 px-1">
          {experimentId == null && !loading && (
            <SidebarGroup>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className="bg-primary font-medium text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground disabled:opacity-50"
                    disabled={!canStart}
                    onClick={onStart}
                    tooltip="Start 7-day experiment"
                  >
                    <PlayIcon />
                    <span>{canStart ? 'Start 7-day experiment' : 'Waiting for live data…'}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          )}
          {navGroups.map((g, i) => (
            <NavGroup key={i} {...g} pathname={pathname} />
          ))}
        </SidebarContent>
        <SidebarFooter className="gap-2 px-3 pb-4">
          {countdown && (
            <div className="flex flex-col gap-1.5 rounded-xl bg-card px-3.5 py-3 transition-opacity group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0">
              <span className="text-[11px] text-muted-foreground">Experiment #{experimentId}</span>
              <p className="num text-[13px] font-medium">
                <SubtleNumber text={countdown.label} value={countdown.msLeft} />
              </p>
              <div className="h-1 overflow-hidden rounded-full bg-surface-2">
                <div className="t-meter-fill h-1 rounded-full bg-primary" style={{ width: `${countdown.progress * 100}%` }} />
              </div>
              <SoftText className="text-[11px] text-muted-foreground" text={countdown.detail} />
            </div>
          )}
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="text-muted-foreground" size="sm" tooltip="Report">
                <a href="/api/report" rel="noreferrer" target="_blank">
                  <FileTextIcon />
                  <span>{hasReport ? 'Final report' : 'Interim report (JSON)'}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 overflow-hidden bg-background">
        <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between gap-3 bg-background px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <CustomSidebarTrigger />
            <span className="truncate text-sm font-medium">{active.title}</span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <PaperBadge />
            <span className="hidden items-center gap-2 md:flex">
              <StatusIndicator color={loading ? 'sky' : dataLive ? 'emerald' : 'rose'} pulse={false} />
              <SoftText className="text-muted-foreground" text={loading ? 'Checking market data' : dataLive ? 'Market data live' : 'Market data stale'} />
            </span>
            {solUsd != null && (
              <span className="num hidden text-muted-foreground lg:inline">
                SOL <SubtleNumber className="text-foreground" text={`$${solUsd.toFixed(2)}`} value={solUsd} />
              </span>
            )}
            <span className="hidden items-center gap-2 font-medium sm:flex">
              <StatusIndicator color={status.tone} pulse={status.tone === 'emerald'} />
              <SoftText text={status.label} />
            </span>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto" id="scroll-root">
          <div className="mx-auto flex w-full max-w-[1360px] flex-col gap-6 px-4 pt-2 pb-12 md:gap-8 md:px-8 md:pt-4 lg:px-10">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
