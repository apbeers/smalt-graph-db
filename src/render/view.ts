/**
 * The graph view: owns the GPU resources, the layout, the camera and the frame loop. It renders on
 * demand: a frame is requested only when something changed (layout running, camera moving, hover,
 * graph or style changes), so an idle view does no GPU work.
 */
import {
  boundsOf, clamp, convertCamera, defaultCamera, dolly, easeInOut, fitCamera, lerpCamera, orbit, pan,
  project, scalePx, unproject, viewProjection, zoomAt2d,
} from './camera.js';
import type { Bounds, CameraState, Projected } from './camera.js';
import { buildCsr, degreeOrder, edgeEndpoints } from './csr.js';
import type { Csr } from './csr.js';
import { GrowableBuffer } from './gpu.js';
import type { Gpu } from './gpu.js';
import { nextCapacity } from './growth.js';
import { InputController } from './input.js';
import type { InputHost } from './input.js';
import { ALL_LABELS_BELOW, GlyphAtlas, LABEL_CAP, MAX_LABEL_CHARS, buildGlyphInstances, chooseLabels, shouldShowAll } from './labels.js';
import { GpuLayout, decayForTicks } from './layout.js';
import { FAMILY_PALETTE_DARK, FAMILY_PALETTE_LIGHT, GroupColors, THEMES, packRgba8, parseColor } from './palette.js';
import type { Rgba } from './palette.js';
import { PICK_FORMAT, Picker } from './picking.js';
import type { PickRequest } from './picking.js';
import { matchNodes } from './search.js';
import { DRAW_WGSL } from './shaders/draw.wgsl.js';
import type {
  GraphView, GraphViewOptions, GraphViewStats, Hit, LayoutControl, RenderEdge, RenderGraph, RenderNode, Theme, ViewMode,
} from './types.js';

/** World radius of a node of size 1. */
const BASE_RADIUS = 4;
const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
const MIRROR_EVERY_TICKS = 12;
const LABEL_THROTTLE_MS = 120;
const ANIM_MS = 450;

interface Pipelines {
  pick?: boolean;
  node: GPURenderPipeline;
  edge: GPURenderPipeline;
  label?: GPURenderPipeline;
}

interface Anim {
  from: CameraState;
  to: CameraState;
  t0: number;
  ms: number;
}

function putColor(f: Float32Array, o: number, c: Rgba, alpha: number): void {
  f[o] = c[0];
  f[o + 1] = c[1];
  f[o + 2] = c[2];
  f[o + 3] = c[3] * alpha;
}

/** Deterministic hash in 0..1 for seeding positions. */
function hash01(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** d3-style phyllotaxis seed (a sphere spiral in 3D). */
function seedPosition(i: number, mode: ViewMode, out: Float32Array, o: number): void {
  if (mode === '2d') {
    const r = 10 * Math.sqrt(0.5 + i);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    out[o] = r * Math.cos(a);
    out[o + 1] = r * Math.sin(a);
    out[o + 2] = 0;
  } else {
    const r = 10 * Math.cbrt(0.5 + i);
    const yaw = i * Math.PI * (3 - Math.sqrt(5));
    const roll = i * ((Math.PI * 20) / (9 + Math.sqrt(221)));
    out[o] = r * Math.sin(roll) * Math.cos(yaw);
    out[o + 1] = r * Math.cos(roll);
    out[o + 2] = r * Math.sin(roll) * Math.sin(yaw);
  }
  out[o + 3] = 1;
}

export class GraphViewImpl implements GraphView {
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly lay: GpuLayout;
  private readonly styleBuf: GrowableBuffer;
  private readonly edgeBuf: GrowableBuffer;
  private readonly glyphBuf: GrowableBuffer;
  private readonly frameBuf: GPUBuffer;
  private readonly pickFrameBuf: GPUBuffer;
  private readonly frameData = new ArrayBuffer(256);
  private readonly frameF32 = new Float32Array(this.frameData);
  private readonly frameU32 = new Uint32Array(this.frameData);
  private readonly bgl: GPUBindGroupLayout;
  private readonly draw2d: Pipelines;
  private readonly draw3d: Pipelines;
  private readonly pick2d: Pipelines;
  private readonly pick3d: Pipelines;
  private readonly sampler: GPUSampler;
  private readonly picker: Picker;
  private atlas: GlyphAtlas;
  private bindGroup: GPUBindGroup | null = null;
  private pickBindGroup: GPUBindGroup | null = null;
  private bindKey = '';
  private depthTex: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  /** Reused pass descriptors (views are filled in per frame). */
  private readonly drawPass: GPURenderPassDescriptor;
  private readonly pickPass: GPURenderPassDescriptor;

  // Graph.
  private nodes: RenderNode[] = [];
  private edges: RenderEdge[] = [];
  private n = 0;
  private m = 0;
  private pairs: Uint32Array = new Uint32Array(0);
  private csr: Csr = { offsets: new Uint32Array(1), neighbors: new Uint32Array(0) };
  private order: Uint32Array = new Uint32Array(0);
  private slots = new Uint32Array(0);
  private styleData = new ArrayBuffer(16 * 64);
  private styleU32 = new Uint32Array(this.styleData);
  private styleF32 = new Float32Array(this.styleData);
  private hl = new Uint8Array(0);
  private hlActive = false;
  private hlList: number[] = [];
  private mirror = new Float32Array(0);
  private readScratch = new Float32Array(0);
  private bounds: Bounds = { min: [0, 0, 0], max: [0, 0, 0], radius: 0, count: 0 };
  private idIndex = new Map<string | number, number>();
  private readonly groups = new GroupColors();
  private gen = 0;

  // View.
  private mode: ViewMode;
  private theme: Theme;
  private labelsOn: boolean;
  private readonly customPalette: string[] | null;
  private readonly background: 'transparent' | 'theme';
  private cam: CameraState = defaultCamera();
  private anim: Anim | null = null;
  private autoFit = true;
  private hover: Hit | null = null;
  private hoverAt = { x: -1, y: -1 };
  private pickedAt = { x: -1, y: -1 };
  private focused = -1;
  private drag: { node: number; depth: number; dx: number; dy: number } | null = null;
  private hoverCb: ((hit: Hit | null) => void) | null = null;
  private clickCb: ((hit: Hit | null) => void) | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private readonly vp = new Float32Array(16);
  private readonly proj: Projected = { x: 0, y: 0, depth: 0, w: 0 };

  // Labels.
  private glyphData = new Uint32Array(LABEL_CAP * MAX_LABEL_CHARS * 4);
  private glyphCount = 0;
  private labelsDirty = true;
  private labelsDue = 0;

  // Loop.
  private raf = 0;
  private needsDraw = true;
  private stylesDirty = true;
  private layoutActive = false;
  private switching = false;
  private mirrorPromise: Promise<void> | null = null;
  private readonly frameTimes = new Float64Array(128);
  private frameHead = 0;
  private destroyed = false;
  private lost = false;
  private readonly ro: ResizeObserver | null;
  private readonly input: InputController;
  private readonly onDpr = () => this.resize();
  private dprQuery: MediaQueryList | null = null;

  readonly layout: LayoutControl;

  constructor(private readonly canvas: HTMLCanvasElement, gpu: Gpu, opts: GraphViewOptions) {
    this.device = gpu.device;
    this.context = gpu.context;
    this.mode = opts.mode ?? '2d';
    this.theme = opts.theme ?? 'light';
    this.labelsOn = opts.labels ?? true;
    this.customPalette = opts.palette && opts.palette.length > 0 ? [...opts.palette] : null;
    this.background = opts.background ?? 'transparent';
    const device = this.device;

    this.lay = new GpuLayout(device, gpu.timestamps);
    if (opts.layoutTicks !== undefined) this.lay.settings.alphaDecay = decayForTicks(opts.layoutTicks);
    this.lay.dims = this.mode === '2d' ? 2 : 3;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.styleBuf = new GrowableBuffer(device, 'render.styles', S, 16);
    this.edgeBuf = new GrowableBuffer(device, 'render.edges', S, 8);
    this.glyphBuf = new GrowableBuffer(device, 'render.glyphs', S, 16);
    const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.frameBuf = device.createBuffer({ label: 'render.frame', size: 256, usage: U });
    this.pickFrameBuf = device.createBuffer({ label: 'render.pickFrame', size: 256, usage: U });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.picker = new Picker(device);
    this.drawPass = {
      label: 'render',
      colorAttachments: [{ view: null as unknown as GPUTextureView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: null as unknown as GPUTextureView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    };
    this.pickPass = {
      label: 'pick',
      colorAttachments: [{ view: this.picker.color.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.picker.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    };
    this.dpr = globalThis.devicePixelRatio || 1;
    this.atlas = new GlyphAtlas(device, this.dpr);

    const V = GPUShaderStage.VERTEX, FR = GPUShaderStage.FRAGMENT;
    this.bgl = device.createBindGroupLayout({
      label: 'render',
      entries: [
        { binding: 0, visibility: V | FR, buffer: { type: 'uniform' } },
        { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: FR, texture: { sampleType: 'float' } },
        { binding: 6, visibility: FR, sampler: { type: 'filtering' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    const module = device.createShaderModule({ label: 'draw', code: DRAW_WGSL });
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    const make = (vs: string, fs: string, pick: boolean, depthWrite: boolean, compare: GPUCompareFunction) =>
      device.createRenderPipeline({
        label: `${vs}/${fs}`,
        layout,
        vertex: { module, entryPoint: vs },
        fragment: {
          module,
          entryPoint: fs,
          targets: [pick ? { format: PICK_FORMAT } : { format: gpu.format, blend }],
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: depthWrite, depthCompare: compare },
      });
    this.draw2d = {
      node: make('vs_node', 'fs_node', false, false, 'always'),
      edge: make('vs_edge', 'fs_edge', false, false, 'always'),
      label: make('vs_label', 'fs_label', false, false, 'always'),
    };
    this.draw3d = {
      node: make('vs_node', 'fs_node', false, true, 'less'),
      edge: make('vs_edge', 'fs_edge', false, false, 'less'),
      label: this.draw2d.label!,
    };
    this.pick2d = {
      pick: true,
      node: make('vs_node', 'fs_node_pick', true, false, 'always'),
      edge: make('vs_edge', 'fs_edge_pick', true, false, 'always'),
    };
    this.pick3d = {
      pick: true,
      node: make('vs_node', 'fs_node_pick', true, true, 'less'),
      edge: make('vs_edge', 'fs_edge_pick', true, false, 'less'),
    };

    device.lost.then((info) => {
      this.lost = true;
      if (!this.destroyed) console.error(`smaltcy render: GPU device lost (${info.reason}): ${info.message}`);
    });

    const self = this;
    this.layout = {
      start() {
        self.layoutActive = true;
        if (self.lay.alpha < self.lay.settings.alphaMin) self.lay.alpha = 0.3;
        self.requestFrame();
      },
      stop() {
        self.layoutActive = false;
      },
      get running() {
        return self.n > 0 && (self.switching || (self.layoutActive && self.lay.running));
      },
      reheat() {
        self.lay.alpha = 1;
        self.layoutActive = true;
        self.requestFrame();
      },
    };

    this.input = new InputController(canvas, this.inputHost());
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((entries) => this.observed(entries)) : null;
    try {
      this.ro?.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      this.ro?.observe(canvas);
    }
    this.watchDpr();
    this.resize();
  }

  // ---- public API -----------------------------------------------------------------------------

  setGraph(g: RenderGraph, opts?: { keepPositions?: boolean }): void {
    if (this.destroyed) return;
    const keep = !!opts?.keepPositions && this.n > 0;
    const oldMirror = this.mirror;
    const oldIndex = this.idIndex;
    const nodes = g.nodes;
    const n = nodes.length;
    const m = g.edges.length;
    this.nodes = nodes;
    this.edges = g.edges;
    this.n = n;
    this.m = m;
    this.gen++;

    this.pairs = edgeEndpoints(n, g.edges);
    this.csr = buildCsr(n, this.pairs, m);
    this.order = degreeOrder(this.csr);
    this.slots = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.slots[i] = this.groups.slot(nodes[i]!.group);

    // Positions: kept by id, new nodes next to a placed neighbour, else on the seed spiral.
    const pos = new Float32Array(nextCapacity(n, 0) * 4);
    const placed = new Uint8Array(n);
    const index = new Map<string | number, number>();
    let kept = 0;
    for (let i = 0; i < n; i++) {
      const id = nodes[i]!.id;
      if (!index.has(id)) index.set(id, i);
      const old = keep ? oldIndex.get(id) : undefined;
      if (old !== undefined && old * 4 + 3 < oldMirror.length) {
        pos.set(oldMirror.subarray(old * 4, old * 4 + 4), i * 4);
        placed[i] = 1;
        kept++;
      }
    }
    let seed = keep ? kept : 0;
    for (let i = 0; i < n; i++) {
      if (placed[i]) continue;
      let anchor = -1;
      if (kept > 0) {
        for (let k = this.csr.offsets[i]!; k < this.csr.offsets[i + 1]!; k++) {
          const j = this.csr.neighbors[k]!;
          if (placed[j]) {
            anchor = j;
            break;
          }
        }
      }
      if (anchor >= 0) {
        const a = hash01(i) * Math.PI * 2;
        const r = 8 + 8 * hash01(i + 7919);
        pos[i * 4] = pos[anchor * 4]! + r * Math.cos(a);
        pos[i * 4 + 1] = pos[anchor * 4 + 1]! + r * Math.sin(a);
        pos[i * 4 + 2] = this.mode === '3d' ? pos[anchor * 4 + 2]! + r * (hash01(i + 104729) - 0.5) : 0;
        pos[i * 4 + 3] = 1;
      } else {
        seedPosition(seed++, this.mode, pos, i * 4);
      }
      placed[i] = 1;
    }
    this.idIndex = index;
    this.mirror = pos;
    this.bounds = boundsOf(pos, n);

    this.lay.setGraph(n, pos, this.csr);
    this.lay.alpha = keep ? Math.max(this.lay.alpha, 0.3 + 0.7 * (1 - kept / Math.max(n, 1))) : 1;
    this.layoutActive = n > 0;

    this.edgeBuf.ensure(m);
    this.edgeBuf.write(this.pairs, m);
    this.styleBuf.ensure(n);
    if (this.styleU32.length < this.styleBuf.capacity * 4) {
      this.styleData = new ArrayBuffer(this.styleBuf.capacity * 16);
      this.styleU32 = new Uint32Array(this.styleData);
      this.styleF32 = new Float32Array(this.styleData);
    }
    this.hl = new Uint8Array(n);
    this.hlActive = false;
    this.hlList = [];
    this.focused = -1;
    if (this.drag) this.dragEnd();
    this.setHover(null);
    this.stylesDirty = true;
    this.labelsDirty = true;
    this.labelsDue = 0;
    this.needsDraw = true;

    if (!keep) {
      this.autoFit = true;
      this.anim = null;
      this.cam = this.fitState(this.cam);
    }
    this.requestFrame();
  }

  setMode(mode: ViewMode): void {
    if (mode === this.mode || this.destroyed) return;
    this.mode = mode;
    this.lay.dims = mode === '2d' ? 2 : 3;
    this.anim = null;
    this.cam = convertCamera(this.cam, mode, Math.max(this.height, 1));
    if (mode === '3d') this.animateTo({ ...this.cam, yaw: 0.55, pitch: -0.3 }, 700);
    this.switching = true;
    const gen = this.gen;
    void this.refreshMirror().then(() => {
      this.switching = false;
      this.requestFrame();
      if (gen !== this.gen || this.destroyed) return;
      const p = this.mirror;
      const spread = Math.max(this.bounds.radius, 20) * 0.6;
      for (let i = 0; i < this.n; i++) p[i * 4 + 2] = mode === '3d' ? (hash01(i) - 0.5) * spread : 0;
      this.lay.setPositions(p);
      this.bounds = boundsOf(p, this.n);
      this.lay.alpha = Math.max(this.lay.alpha, mode === '3d' ? 0.6 : 0.3);
      this.layoutActive = this.n > 0;
      this.invalidate(true);
    });
    this.invalidate(true);
  }

  setTheme(theme: Theme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.stylesDirty = true;
    this.invalidate(false);
  }

  setLabels(on: boolean): void {
    this.labelsOn = on;
    this.invalidate(true);
  }

  highlight(indices: number[] | null): void {
    this.focused = -1;
    this.hl.fill(0);
    this.hlList = [];
    this.hlActive = indices !== null;
    if (indices) {
      for (const i of indices) {
        if (Number.isInteger(i) && i >= 0 && i < this.n && !this.hl[i]) {
          this.hl[i] = 1;
          this.hlList.push(i);
        }
      }
    }
    this.stylesDirty = true;
    this.invalidate(true);
  }

  search(text: string): number[] {
    if (!text.trim()) {
      this.highlight(null);
      return [];
    }
    const found = matchNodes(this.nodes, text);
    this.highlight(found);
    return found;
  }

  focus(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.n) return;
    this.focused = index;
    this.autoFit = false;
    this.invalidate(true);
    const gen = this.gen;
    void this.refreshMirror().then(() => {
      if (gen !== this.gen || this.destroyed) return;
      const p = this.mirror;
      const base = this.anim ? this.anim.to : this.cam;
      const to = { ...base, x: p[index * 4]!, y: p[index * 4 + 1]!, z: this.mode === '3d' ? p[index * 4 + 2]! : 0 };
      if (this.mode === '2d') to.zoom = Math.max(base.zoom, 2.5 * this.dpr);
      else to.distance = Math.min(base.distance, 160);
      this.animateTo(to, ANIM_MS);
    });
  }

  fit(): void {
    const gen = this.gen;
    void this.refreshMirror().then(() => {
      if (gen !== this.gen || this.destroyed) return;
      this.animateTo(this.fitState(this.anim ? this.anim.to : this.cam), ANIM_MS);
    });
  }

  onHover(cb: (hit: Hit | null) => void): void {
    this.hoverCb = cb;
  }

  onClick(cb: (hit: Hit | null) => void): void {
    this.clickCb = cb;
  }

  async positions(): Promise<Float32Array> {
    const n = this.n;
    if (n === 0) return new Float32Array(0);
    const tmp = new Float32Array(n * 4);
    await this.lay.readPositions(tmp, n);
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      out[i * 3] = tmp[i * 4]!;
      out[i * 3 + 1] = tmp[i * 4 + 1]!;
      out[i * 3 + 2] = tmp[i * 4 + 2]!;
    }
    return out;
  }

  stats(): GraphViewStats {
    // Frames per second over the frames drawn in the last few seconds (0 when idle). With a
    // single recent frame, the interval to the frame before it.
    const now = performance.now();
    const ring = this.frameTimes, len = ring.length;
    const newest = ring[(this.frameHead + len - 1) % len]!;
    let fps = 0;
    if (newest > 0 && now - newest <= 3000) {
      let count = 1, oldest = newest;
      for (let k = 2; k <= len; k++) {
        const t = ring[(this.frameHead + len - k) % len]!;
        if (t <= 0) break;
        if (now - t > 3000) {
          if (count === 1) {
            count = 2;
            oldest = t;
          }
          break;
        }
        count++;
        oldest = t;
      }
      if (count >= 2 && newest > oldest) fps = ((count - 1) * 1000) / (newest - oldest);
    }
    return { nodes: this.n, edges: this.m, fps: Math.round(fps * 10) / 10, layoutMsPerTick: this.lay.msPerTick };
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.setDpr(globalThis.devicePixelRatio || 1);
    this.applySize(Math.round(r.width * this.dpr), Math.round(r.height * this.dpr));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.input.destroy();
    this.picker.destroy();
    this.atlas.destroy();
    this.lay.destroy();
    this.styleBuf.destroy();
    this.edgeBuf.destroy();
    this.glyphBuf.destroy();
    this.frameBuf.destroy();
    this.pickFrameBuf.destroy();
    this.depthTex?.destroy();
    try {
      this.context.unconfigure();
    } catch {
      /* already gone */
    }
    this.device.destroy();
  }

  // ---- input host -----------------------------------------------------------------------------

  private inputHost(): InputHost {
    return {
      mode: () => this.mode,
      scale: () => this.cssScale(),
      pan: (dx, dy) => {
        this.anim = null;
        pan(this.cam, this.mode, this.height, dx, dy);
        this.invalidate(true);
      },
      orbit: (dx, dy) => {
        this.anim = null;
        orbit(this.cam, dx, dy);
        this.invalidate(true);
      },
      zoomAt: (x, y, factor) => {
        this.anim = null;
        if (this.mode === '2d') zoomAt2d(this.cam, this.width, this.height, x, y, factor);
        else dolly(this.cam, 1 / factor);
        this.invalidate(true);
      },
      hover: (x, y) => {
        this.hoverAt = { x, y };
        void this.picker.request(x, y).then((hit) => {
          this.pickedAt = { x, y };
          if (this.drag) return;
          if (this.hoverAt.x === x && this.hoverAt.y === y) this.setHover(this.validHit(hit));
        });
        this.requestFrame();
      },
      leave: () => {
        this.hoverAt = { x: -1, y: -1 };
        this.setHover(null);
      },
      pick: (x, y) => this.pickAt(x, y),
      lastHover: () => ({ hit: this.hover, x: this.pickedAt.x, y: this.pickedAt.y }),
      dragStart: (node, x, y) => this.dragStart(node, x, y),
      dragMove: (x, y) => this.dragMove(x, y),
      dragEnd: () => this.dragEnd(),
      click: (hit) => this.clickCb?.(this.validHit(hit)),
      interacted: () => {
        this.autoFit = false;
      },
    };
  }

  /** GPU pick at a canvas pixel (device pixels). */
  private pickAt(x: number, y: number): Promise<Hit | null> {
    const p = this.picker.request(x, y).then((hit) => this.validHit(hit));
    this.requestFrame();
    return p;
  }

  private cssScale(): number {
    const w = this.canvas.getBoundingClientRect().width;
    return w > 0 && this.width > 0 ? this.width / w : this.dpr;
  }

  pick(x: number, y: number): Promise<Hit | null> {
    const k = this.cssScale();
    return this.pickAt(x * k, y * k);
  }

  screenPosition(index: number): { x: number; y: number } | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.n) return null;
    this.computeViewProj();
    const p = project(this.vp, this.width, this.height, this.mirror.subarray(index * 4, index * 4 + 3));
    if (!(p.w > 0)) return null;
    const k = this.cssScale();
    return { x: p.x / k, y: p.y / k };
  }

  sync(): Promise<void> {
    return this.refreshMirror();
  }

  private dragStart(node: number, x: number, y: number): void {
    if (node < 0 || node >= this.n) return;
    this.computeViewProj();
    const p = project(this.vp, this.width, this.height, this.mirror.subarray(node * 4, node * 4 + 3), this.proj);
    this.drag = { node, depth: p.depth, dx: p.x - x, dy: p.y - y };
    this.anim = null;
    this.autoFit = false;
    this.lay.setPinned(node, true);
    this.lay.alphaTarget = 0.3;
    this.layoutActive = true;
    this.setHover({ kind: 'node', index: node });
    this.requestFrame();
  }

  private dragMove(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    this.computeViewProj();
    const w = unproject(this.vp, this.width, this.height, x + d.dx, y + d.dy, d.depth);
    if (this.mode === '2d') w[2] = 0;
    const o = d.node * 4;
    this.mirror[o] = w[0];
    this.mirror[o + 1] = w[1];
    this.mirror[o + 2] = w[2];
    this.lay.setNodePosition(d.node, w[0], w[1], w[2]);
    this.invalidate(false);
  }

  private dragEnd(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.lay.setPinned(d.node, false);
    this.lay.alphaTarget = 0;
    this.requestFrame();
  }

  // ---- internals ------------------------------------------------------------------------------

  private validHit(hit: Hit | null): Hit | null {
    if (!hit) return null;
    if (hit.kind === 'node' && hit.index < this.n) return hit;
    if (hit.kind === 'edge' && hit.index < this.m) return hit;
    return null;
  }

  private setHover(hit: Hit | null): void {
    const h = this.hover;
    if (h === hit || (h && hit && h.kind === hit.kind && h.index === hit.index)) return;
    this.hover = hit;
    this.canvas.style.cursor = hit?.kind === 'node' ? 'pointer' : '';
    this.hoverCb?.(hit);
    this.labelsDue = 0;
    this.invalidate(true);
  }

  private invalidate(labels: boolean): void {
    this.needsDraw = true;
    if (labels) this.labelsDirty = true;
    this.requestFrame();
  }

  private requestFrame(): void {
    if (!this.raf && !this.destroyed && !this.lost) this.raf = requestAnimationFrame(this.frame);
  }

  private observed(entries: ResizeObserverEntry[]): void {
    const e = entries[entries.length - 1];
    if (!e) return;
    this.setDpr(globalThis.devicePixelRatio || 1);
    const box = e.devicePixelContentBoxSize?.[0];
    if (box) this.applySize(box.inlineSize, box.blockSize);
    else this.applySize(Math.round(e.contentRect.width * this.dpr), Math.round(e.contentRect.height * this.dpr));
  }

  private watchDpr(): void {
    if (typeof matchMedia !== 'function') return;
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.dprQuery = matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener('change', this.onDpr);
  }

  private setDpr(dpr: number): void {
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    this.atlas.destroy();
    this.atlas = new GlyphAtlas(this.device, dpr);
    this.bindKey = '';
    this.watchDpr();
    this.invalidate(true);
  }

  private applySize(w: number, h: number): void {
    w = Math.max(0, w);
    h = Math.max(0, h);
    if (w === this.width && h === this.height) return;
    const first = this.width === 0 || this.height === 0;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.max(1, w);
    this.canvas.height = Math.max(1, h);
    if (first && this.autoFit && this.n > 0) this.cam = this.fitState(this.cam);
    this.invalidate(true);
  }

  private fitState(from: CameraState): CameraState {
    let maxR = BASE_RADIUS;
    for (let i = 0; i < this.n; i++) {
      const s = this.nodes[i]!.size;
      if (s !== undefined && s > 1) maxR = Math.max(maxR, BASE_RADIUS * Math.sqrt(s));
    }
    const w = Math.max(this.width, 1), h = Math.max(this.height, 1);
    return fitCamera(this.bounds, this.mode, w, h, 24 * this.dpr, maxR, from);
  }

  private animateTo(to: CameraState, ms: number): void {
    this.anim = { from: { ...this.cam }, to, t0: performance.now(), ms };
    this.invalidate(true);
  }

  private refreshMirror(): Promise<void> {
    if (this.mirrorPromise) return this.mirrorPromise;
    const n = this.n;
    const gen = this.gen;
    if (n === 0) return Promise.resolve();
    if (this.readScratch.length < n * 4) this.readScratch = new Float32Array(nextCapacity(n, 0) * 4);
    const p = this.lay
      .readPositions(this.readScratch, n)
      .then(() => {
        if (gen !== this.gen || this.destroyed) return;
        this.mirror.set(this.readScratch.subarray(0, n * 4));
        this.bounds = boundsOf(this.mirror, n);
        if (this.autoFit) {
          const base = this.anim ? this.anim.to : this.cam;
          this.animateTo(this.fitState(base), 300);
        }
        this.labelsDirty = true;
        this.requestFrame();
      })
      .catch(() => {})
      .finally(() => {
        this.mirrorPromise = null;
      });
    this.mirrorPromise = p;
    return p;
  }

  private computeViewProj(): void {
    viewProjection(this.cam, this.mode, Math.max(this.width, 1), Math.max(this.height, 1), this.bounds.radius, this.vp);
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    if (this.destroyed || this.lost) return;
    let again = false;

    // Layout.
    if (this.layoutActive && !this.switching && this.n > 0) {
      if (this.lay.running) {
        const ms = this.lay.msPerTick;
        const ticks = ms > 0 ? clamp(Math.floor(8 / ms), 1, 4) : 1;
        for (let t = 0; t < ticks; t++) {
          this.lay.tick();
          if (this.lay.ticks % MIRROR_EVERY_TICKS === 0) void this.refreshMirror();
        }
        this.needsDraw = true;
        again = true;
      } else {
        this.layoutActive = false;
        void this.refreshMirror();
      }
    }

    // Camera animation.
    if (this.anim) {
      const a = this.anim;
      const t = Math.min(1, (now - a.t0) / a.ms);
      lerpCamera(a.from, a.to, easeInOut(Math.max(0, t)), this.cam);
      if (t >= 1) this.anim = null;
      else again = true;
      this.needsDraw = true;
      this.labelsDirty = true;
    }

    if (this.stylesDirty) this.uploadStyles();
    if (this.labelsDirty) {
      if (now >= this.labelsDue) {
        this.labelsDirty = false;
        this.labelsDue = now + LABEL_THROTTLE_MS;
        this.updateLabels();
        this.needsDraw = true;
      } else {
        again = true;
      }
    }

    if (this.width > 0 && this.height > 0) {
      this.computeViewProj();
      if (this.needsDraw) {
        this.needsDraw = false;
        this.render();
        this.frameTimes[this.frameHead] = now;
        this.frameHead = (this.frameHead + 1) % this.frameTimes.length;
      }
      const req = this.picker.take();
      if (req) this.renderPick(req);
    }
    if (again) this.requestFrame();
  };

  private uploadStyles(): void {
    this.stylesDirty = false;
    const palette = this.customPalette ?? (this.theme === 'dark' ? FAMILY_PALETTE_DARK : FAMILY_PALETTE_LIGHT);
    const packed = palette.map((c) => packRgba8(parseColor(c)));
    const u = this.styleU32, f = this.styleF32;
    for (let i = 0; i < this.n; i++) {
      const node = this.nodes[i]!;
      const size = node.size !== undefined && Number.isFinite(node.size) ? Math.max(node.size, 0.05) : 1;
      u[i * 4] = packed[this.slots[i]! % packed.length]!;
      f[i * 4 + 1] = BASE_RADIUS * Math.sqrt(size);
      u[i * 4 + 2] = this.hl[i]!;
      u[i * 4 + 3] = 0;
    }
    this.styleBuf.write(this.styleU32, this.n);
    this.needsDraw = true;
  }

  private updateLabels(): void {
    const always: number[] = [];
    if (this.hover?.kind === 'node') always.push(this.hover.index);
    if (this.focused >= 0) always.push(this.focused);
    for (const i of this.hlList) always.push(i);
    let showAll = false;
    if (this.labelsOn && this.n > 0) {
      let spacing: number;
      const b = this.bounds;
      if (this.mode === '2d') {
        const area = Math.max((b.max[0] - b.min[0]) * (b.max[1] - b.min[1]), 1);
        spacing = Math.sqrt(area / this.n) * this.cam.zoom;
      } else {
        spacing = ((2 * Math.max(b.radius, 1)) / Math.cbrt(this.n)) * (scalePx(this.cam, '3d', this.height) / this.cam.distance);
      }
      showAll = shouldShowAll(this.n, spacing, this.dpr);
    }
    let visible: ((i: number) => boolean) | undefined;
    if (showAll) {
      this.computeViewProj();
      const W = this.width, H = this.height, mirror = this.mirror, vp = this.vp, pr = this.proj;
      const margin = 40 * this.dpr;
      visible = (i) => {
        project(vp, W, H, mirror.subarray(i * 4, i * 4 + 3), pr);
        return pr.w > 0 && pr.depth <= 1 && pr.x > -margin && pr.x < W + margin && pr.y > -margin && pr.y < H + margin;
      };
    }
    // While a highlight is active in a larger graph, only highlighted nodes keep their labels.
    if (showAll && this.hlActive && this.n > ALL_LABELS_BELOW) showAll = false;
    const chosen = chooseLabels({ nodeCount: this.n, order: this.order, always, showAll, visible });
    this.glyphCount = buildGlyphInstances(this.nodes, chosen, (ch) => this.atlas.slot(ch), this.glyphData);
    this.glyphBuf.ensure(this.glyphCount);
    this.glyphBuf.write(this.glyphData, this.glyphCount);
  }

  private ensureTargets(): void {
    if (!this.depthTex || this.depthTex.width !== this.width || this.depthTex.height !== this.height) {
      this.depthTex?.destroy();
      this.depthTex = this.device.createTexture({
        label: 'render.depth',
        size: [this.width, this.height],
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthView = this.depthTex.createView();
    }
    const key = `${this.lay.pos.version}.${this.styleBuf.version}.${this.edgeBuf.version}.${this.glyphBuf.version}.${this.atlas.fontPx}`;
    if (key !== this.bindKey || !this.bindGroup) {
      this.bindKey = key;
      const entries = (frame: GPUBuffer): GPUBindGroupEntry[] => [
        { binding: 0, resource: { buffer: frame } },
        { binding: 1, resource: { buffer: this.lay.pos.buffer } },
        { binding: 2, resource: { buffer: this.styleBuf.buffer } },
        { binding: 3, resource: { buffer: this.edgeBuf.buffer } },
        { binding: 4, resource: { buffer: this.glyphBuf.buffer } },
        { binding: 5, resource: this.atlas.texture.createView() },
        { binding: 6, resource: this.sampler },
      ];
      this.bindGroup = this.device.createBindGroup({ label: 'render', layout: this.bgl, entries: entries(this.frameBuf) });
      this.pickBindGroup = this.device.createBindGroup({ label: 'pick', layout: this.bgl, entries: entries(this.pickFrameBuf) });
    }
  }

  private fillFrame(pick: PickRequest | null): void {
    const f = this.frameF32, u = this.frameU32;
    const t = THEMES[this.theme];
    f.set(this.vp, 0);
    f[16] = this.width;
    f[17] = this.height;
    f[18] = this.dpr;
    f[19] = scalePx(this.cam, this.mode, this.height);
    if (pick) {
      f[20] = Math.floor(pick.x);
      f[21] = Math.floor(pick.y);
      f[22] = 1;
      f[23] = 1;
    } else {
      f[20] = 0;
      f[21] = 0;
      f[22] = this.width;
      f[23] = this.height;
    }
    const edgeAlpha = this.m > 4000 ? 0.55 : this.m > 500 ? 0.75 : 0.9;
    putColor(f, 24, t.edge, edgeAlpha);
    putColor(f, 28, t.edgeStrong, 1);
    putColor(f, 32, t.accent, 1);
    putColor(f, 36, t.surface, 1);
    putColor(f, 40, t.text, 1);
    // Fog over the depth of the scene in 3D.
    const r = Math.max(this.bounds.radius, 1);
    f[44] = Math.max(0, this.cam.distance - r * 0.6);
    f[45] = this.cam.distance + r * 1.1;
    f[46] = 0.7;
    f[47] = t.dim;
    f[48] = this.atlas.advance;
    f[49] = this.atlas.cellW;
    f[50] = this.atlas.cellH;
    f[51] = this.atlas.cols;
    f[52] = this.atlas.width;
    f[53] = this.atlas.height;
    f[54] = 2 * this.dpr;
    f[55] = 1;
    u[56] = this.hover?.kind === 'node' ? this.hover.index + 1 : 0;
    u[57] = this.hover?.kind === 'edge' ? this.hover.index + 1 : 0;
    u[58] = this.hlActive ? 1 : 0;
    u[59] = this.mode === '3d' ? 1 : 0;
    u[60] = pick ? 1 : 0;
    u[61] = 1;
    u[62] = this.n;
    u[63] = this.focused + 1;
  }

  private encodeScene(pass: GPURenderPassEncoder, p: Pipelines): void {
    // 2D: edges under nodes. 3D: nodes first so that edges are depth-tested against them, except
    // when picking, where nodes are drawn last so that a node wins over an edge in front of it.
    const nodesFirst = this.mode === '3d' && !p.pick;
    if (nodesFirst && this.n > 0) {
      pass.setPipeline(p.node);
      pass.draw(6, this.n);
    }
    if (this.m > 0) {
      pass.setPipeline(p.edge);
      pass.draw(12, this.m);
    }
    if (!nodesFirst && this.n > 0) {
      pass.setPipeline(p.node);
      pass.draw(6, this.n);
    }
    if (p.label && this.glyphCount > 0) {
      pass.setPipeline(p.label);
      pass.draw(6, this.glyphCount);
    }
  }

  private render(): void {
    this.ensureTargets();
    this.atlas.flush();
    this.fillFrame(null);
    this.device.queue.writeBuffer(this.frameBuf, 0, this.frameData);
    const color = this.drawPass.colorAttachments[0]!;
    const bg = THEMES[this.theme].bg;
    const clear = color.clearValue as { r: number; g: number; b: number; a: number };
    const opaque = this.background === 'theme';
    clear.r = opaque ? bg[0] : 0;
    clear.g = opaque ? bg[1] : 0;
    clear.b = opaque ? bg[2] : 0;
    clear.a = opaque ? 1 : 0;
    color.view = this.context.getCurrentTexture().createView();
    this.drawPass.depthStencilAttachment!.view = this.depthView!;
    const enc = this.device.createCommandEncoder({ label: 'render' });
    const pass = enc.beginRenderPass(this.drawPass);
    pass.setBindGroup(0, this.bindGroup);
    this.encodeScene(pass, this.mode === '2d' ? this.draw2d : this.draw3d);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  private renderPick(req: PickRequest): void {
    this.ensureTargets();
    this.fillFrame(req);
    this.device.queue.writeBuffer(this.pickFrameBuf, 0, this.frameData);
    const enc = this.device.createCommandEncoder({ label: 'pick' });
    const pass = enc.beginRenderPass(this.pickPass);
    pass.setBindGroup(0, this.pickBindGroup);
    this.encodeScene(pass, this.mode === '2d' ? this.pick2d : this.pick3d);
    pass.end();
    this.picker.encodeCopy(enc);
    this.device.queue.submit([enc.finish()]);
    this.picker.resolveAfterSubmit(req, () => {
      if (this.picker.wanted) this.requestFrame();
    });
  }
}
