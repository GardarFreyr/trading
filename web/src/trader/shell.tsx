import type { ReactNode } from 'react';
import {
  ActivityIcon,
  ArrowLeftRightIcon,
  BriefcaseIcon,
  FileTextIcon,
  HistoryIcon,
  LayoutGridIcon,
  PlayIcon,
  RadarIcon,
  TrendingUpIcon,
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
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { NavGroup } from '@/components/nav-group';
import type { SidebarNavGroup } from '@/components/app-shared';
import { CustomSidebarTrigger } from '@/components/custom-sidebar-trigger';
import { AppBreadcrumbs } from '@/components/app-breadcrumbs';
import { StatusIndicator } from '@/components/indicator';
import { cn } from '@/lib/utils';

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
}: {
  children: ReactNode;
  pathname: string;
  status: { label: string; tone: StatusTone };
  dataLive: boolean;
  solUsd: number | null;
  countdown: { label: string; detail: string; progress: number } | null;
  experimentId: number | null;
  hasReport: boolean;
  canStart: boolean;
  onStart: () => void;
}) {
  const active = navGroups.flatMap((g) => g.items).find((i) => i.path === pathname) ?? navGroups[0].items[0];
  return (
    <div className="overflow-hidden">
      <SidebarProvider className="relative h-svh">
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader className="h-14 justify-center">
            <SidebarMenuButton asChild>
              <a href="#overview">
                <span className="flex size-5 items-center justify-center rounded bg-emerald-500 text-neutral-950">
                  <TrendingUpIcon className="size-3.5" strokeWidth={3} />
                </span>
                <span className="font-medium">Paper Trader</span>
              </a>
            </SidebarMenuButton>
          </SidebarHeader>
          <SidebarContent>
            {experimentId == null && (
              <SidebarGroup>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground disabled:opacity-50"
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
          <SidebarFooter>
            {countdown && (
              <div
                className={cn(
                  'flex flex-col gap-1 rounded-lg border bg-background px-4 pt-3 pb-3',
                  'transition-opacity group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0',
                )}
              >
                <span className="font-mono text-[10px] text-muted-foreground">EXPERIMENT #{experimentId}</span>
                <p className="num text-xs font-medium">{countdown.label}</p>
                <span className="text-[10px] text-muted-foreground">{countdown.detail}</span>
                <div className="mt-1 h-1 rounded-full bg-muted">
                  <div className="h-1 rounded-full bg-sky-500" style={{ width: `${countdown.progress * 100}%` }} />
                </div>
              </div>
            )}
            <SidebarMenu className="mt-2">
              <SidebarMenuItem>
                <SidebarMenuButton asChild className="text-muted-foreground" size="sm">
                  <a href="/api/report" rel="noreferrer" target="_blank">
                    <FileTextIcon />
                    <span>{hasReport ? 'Final report' : 'Interim report (JSON)'}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="md:peer-data-[variant=inset]:ml-0">
          <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background px-4 md:px-6">
            <div className="flex items-center gap-3">
              <CustomSidebarTrigger />
              <Separator className="mr-2 h-4 data-[orientation=vertical]:self-center" orientation="vertical" />
              <AppBreadcrumbs page={active} />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3 text-xs">
              <Badge className="hidden border-amber-500/40 text-amber-500 sm:inline-flex" variant="outline">
                Simulated · no real funds
              </Badge>
              <span className="hidden items-center gap-2 md:flex">
                <StatusIndicator color={dataLive ? 'emerald' : 'rose'} pulse={dataLive} />
                <span className="text-muted-foreground">{dataLive ? 'Market data live' : 'Market data stale'}</span>
              </span>
              {solUsd != null && <span className="num hidden text-muted-foreground lg:inline">SOL ${solUsd.toFixed(2)}</span>}
              <Separator className="h-4 data-[orientation=vertical]:self-center" orientation="vertical" />
              <span className="flex items-center gap-2 font-medium">
                <StatusIndicator color={status.tone} pulse={status.tone === 'emerald'} />
                {status.label}
              </span>
            </div>
          </header>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
