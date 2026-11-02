import type { BulkLaunchSource } from '@workspace/api-client-react';

export const sourceLabel = (source?: string) => ({
  automatic_launcher: 'Automatic launcher',
  manual_selection: 'Manual selection',
  multi_type_widget: 'Multi-type widget',
  run_monitor: 'Run monitor',
  unknown: 'Unknown source',
} as Record<BulkLaunchSource, string>)[source as BulkLaunchSource] ?? 'Unknown source';
