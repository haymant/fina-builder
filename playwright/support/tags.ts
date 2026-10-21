export const TAG = {
  smoke: '@smoke',
  journey: {
    dashboardSetup: '@journey-dashboard-setup',
    dashboardReview: '@journey-dashboard-review',
    notebookCapture: '@journey-notebook-capture',
    visualizationAdd: '@journey-visualization-add',
    preferences: '@journey-preferences',
  },
  feature: {
    workspace: '@feature-workspace',
    dashboards: '@feature-dashboards',
    templates: '@feature-templates',
    visualizations: '@feature-visualizations',
    notebook: '@feature-notebook',
    theme: '@feature-theme',
  },
  dependency: {
    riga: '@requires-riga',
  },
  demo: {
    any: '@demo',
    dashboardNote: '@demo-dashboard-note',
    visualizationAdd: '@demo-visualization-add',
  },
} as const
