// `echarts-gl` ships no TypeScript declarations. It is imported lazily (for the
// 3D volume-surface view in `features/tac`) purely for its side effect:
// registering the `surface` / `grid3D` renderers on the global echarts instance.
declare module 'echarts-gl'
