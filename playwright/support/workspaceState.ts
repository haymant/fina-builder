export type DashboardSeed = {
  id: string
  name: string
  layout: unknown[]
}

export type WorkspaceSeed = {
  dashboards: DashboardSeed[]
  selectedDashboardId: string
  theme: 'dark' | 'light'
}

type WorkspaceSeedOverrides = Partial<WorkspaceSeed>

export function createWorkspaceSeed(overrides: WorkspaceSeedOverrides = {}): WorkspaceSeed {
  const dashboards = overrides.dashboards?.map((dashboard) => ({ ...dashboard, layout: [...dashboard.layout] })) ?? [
    { id: 'playwright-dashboard', name: 'Playwright Dashboard', layout: [] },
  ]

  return {
    dashboards,
    selectedDashboardId: overrides.selectedDashboardId ?? dashboards[0]?.id ?? '',
    theme: overrides.theme ?? 'dark',
  }
}
