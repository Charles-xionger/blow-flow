/** Only an explicitly instrumented build can disable optimizations for A/B measurement. */
export function canvasExperimentDisabled(feature: 'preview' | 'subscriptions') {
  return process.env.NEXT_PUBLIC_CANVAS_PERF_EXPERIMENT === '1' && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get(feature) === '0';
}
