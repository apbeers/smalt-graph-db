/**
 * The GPU graph view: WebGPU only, 2D and 3D, with the force-directed layout in compute shaders. It lives in the
 * smalt family's shared kit (`smaltkit/graph`), so other apps draw graphs with it too; this entry point re-exports it.
 * `createGraphView` rejects with `GpuUnavailableError` when WebGPU is not available.
 */
export * from 'smaltkit/graph';
