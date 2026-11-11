/** Public data types of the graph renderer. */

export interface RenderNode {
  id: string | number;
  label?: string;
  group?: string;
  /** Relative size; 1 is the default. */
  size?: number;
}

export interface RenderEdge {
  /** Index into `nodes`. */
  source: number;
  /** Index into `nodes`. */
  target: number;
  label?: string;
  group?: string;
}

export interface RenderGraph {
  nodes: RenderNode[];
  edges: RenderEdge[];
}

export type ViewMode = '2d' | '3d';
export type Theme = 'light' | 'dark';

export interface GraphViewOptions {
  mode?: ViewMode;
  theme?: Theme;
  labels?: boolean;
  /** Categorical colours for node groups; defaults to the family palette of the theme. */
  palette?: string[];
  /** `'transparent'` (default) lets the page show through; `'theme'` clears to the theme background. */
  background?: 'transparent' | 'theme';
}

export interface Hit {
  kind: 'node' | 'edge';
  index: number;
}

export interface LayoutControl {
  start(): void;
  stop(): void;
  readonly running: boolean;
  reheat(): void;
}

export interface GraphViewStats {
  nodes: number;
  edges: number;
  fps: number;
  layoutMsPerTick: number;
}

export interface GraphView {
  /** Replace the graph. With `keepPositions`, nodes whose id was already shown keep their position. */
  setGraph(g: RenderGraph, opts?: { keepPositions?: boolean }): void;
  /** Switch between 2D and 3D, reusing the layout. */
  setMode(mode: ViewMode): void;
  setTheme(theme: Theme): void;
  setLabels(on: boolean): void;
  /** Highlighted nodes and their incident edges are drawn at full strength, the rest dimmed; null clears. */
  highlight(indices: number[] | null): void;
  /** Case-insensitive match on label, id and group; highlights and returns the matching indices. */
  search(text: string): number[];
  /** Animate the camera to the node. */
  focus(index: number): void;
  /** Frame the whole graph. */
  fit(): void;
  onHover(cb: (hit: Hit | null) => void): void;
  onClick(cb: (hit: Hit | null) => void): void;
  readonly layout: LayoutControl;
  /**
   * GPU pick at a point in CSS pixels relative to the canvas: the node or edge drawn there, or null.
   */
  pick(x: number, y: number): Promise<Hit | null>;
  /**
   * Where a node is on the canvas, in CSS pixels, from the last positions read back from the GPU
   * (call `sync()` first for the current ones); null when it is behind the 3D camera.
   */
  screenPosition(index: number): { x: number; y: number } | null;
  /** Read the current layout positions back from the GPU for `screenPosition`. */
  sync(): Promise<void>;
  /** Read back xyz per node. */
  positions(): Promise<Float32Array>;
  stats(): GraphViewStats;
  resize(): void;
  destroy(): void;
}
