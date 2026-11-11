/** The force-directed layout on the GPU (see shaders/layout.wgsl.ts for the forces). */
import type { Csr } from './csr.js';
import { GrowableBuffer } from './gpu.js';
import { LAYOUT_WGSL } from './shaders/layout.wgsl.js';

const TILE = 256;
/** Above this many nodes, repulsion samples a rotating subset of tiles each tick. */
export const EXACT_REPULSION_LIMIT = 20480;
const SAMPLED_TILES = EXACT_REPULSION_LIMIT / TILE;
const ZERO4 = new Float32Array(4);

export interface LayoutSettings {
  /** Repulsion strength (d3 many-body strength, positive = repel). */
  charge: number;
  linkDistance: number;
  linkStrength: number;
  gravity: number;
  /** d3 velocityDecay. */
  decay: number;
  alphaMin: number;
  alphaDecay: number;
}

export const DEFAULT_LAYOUT: LayoutSettings = {
  charge: 30,
  linkDistance: 30,
  linkStrength: 1,
  gravity: 0.04,
  decay: 0.4,
  alphaMin: 0.001,
  alphaDecay: 1 - Math.pow(0.001, 1 / 300),
};

/** How many repulsion tiles a tick visits and the scale that compensates for the sample. */
export function repulsionTiles(n: number): { total: number; tiles: number; scale: number } {
  const total = Math.max(1, Math.ceil(n / TILE));
  if (n <= EXACT_REPULSION_LIMIT) return { total, tiles: total, scale: 1 };
  return { total, tiles: SAMPLED_TILES, scale: total / SAMPLED_TILES };
}

export class GpuLayout {
  readonly settings: LayoutSettings = { ...DEFAULT_LAYOUT };
  /** Current positions (read by the renderer). vec4 per node. */
  readonly pos: GrowableBuffer;
  private readonly next: GrowableBuffer;
  private readonly vel: GrowableBuffer;
  private readonly pinned: GrowableBuffer;
  private readonly offsets: GrowableBuffer;
  private readonly nbrs: GrowableBuffer;
  private readonly params: GPUBuffer;
  private readonly paramData = new ArrayBuffer(80);
  private readonly paramU32 = new Uint32Array(this.paramData);
  private readonly paramF32 = new Float32Array(this.paramData);
  private readonly pipeline: GPUComputePipeline;
  private bindGroup: GPUBindGroup | null = null;
  private bindKey = '';
  private pinnedData = new Uint32Array(64);
  private readonly zeroVec = new Float32Array(4);
  private readonly one = new Uint32Array([1]);
  private readonly zero = new Uint32Array([0]);

  n = 0;
  dims: 2 | 3 = 2;
  alpha = 0;
  alphaTarget = 0;
  ticks = 0;
  msPerTick = 0;

  private readonly staging: GPUBuffer[] = [];
  private readonly plainPass = { label: 'layout.tick' };
  private readonly timedPass: { label: string; timestampWrites: GPUComputePassTimestampWrites } | null;
  private readonly query: { set: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; busy: boolean } | null;

  constructor(private readonly device: GPUDevice, timestamps: boolean) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.pos = new GrowableBuffer(device, 'layout.pos', S | GPUBufferUsage.COPY_SRC, 16);
    this.next = new GrowableBuffer(device, 'layout.next', S | GPUBufferUsage.COPY_SRC, 16);
    this.vel = new GrowableBuffer(device, 'layout.vel', S, 16);
    this.pinned = new GrowableBuffer(device, 'layout.pinned', S, 4);
    this.offsets = new GrowableBuffer(device, 'layout.offsets', S, 4);
    this.nbrs = new GrowableBuffer(device, 'layout.nbrs', S, 4);
    this.params = device.createBuffer({ label: 'layout.params', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: 'layout', code: LAYOUT_WGSL });
    this.pipeline = device.createComputePipeline({ label: 'layout.tick', layout: 'auto', compute: { module, entryPoint: 'tick' } });
    this.query = timestamps
      ? {
          set: device.createQuerySet({ type: 'timestamp', count: 2 }),
          resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
          read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
          busy: false,
        }
      : null;
    this.timedPass = this.query
      ? { label: 'layout.tick', timestampWrites: { querySet: this.query.set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
      : null;
  }

  /** Upload a graph: positions are stride-4 (xyzw), velocities reset. */
  setGraph(n: number, positions: Float32Array, csr: Csr): void {
    this.n = n;
    this.pos.ensure(n);
    this.next.ensure(n);
    this.vel.ensure(n);
    this.pinned.ensure(n);
    this.offsets.ensure(n + 1);
    this.nbrs.ensure(csr.neighbors.length);
    this.pos.write(positions, n);
    const zeros = new Float32Array(this.vel.capacity * 4);
    this.vel.write(zeros, this.vel.capacity);
    if (this.pinnedData.length < this.pinned.capacity) this.pinnedData = new Uint32Array(this.pinned.capacity);
    this.pinnedData.fill(0);
    this.pinned.write(this.pinnedData, this.pinned.capacity);
    this.offsets.write(csr.offsets, n + 1);
    this.nbrs.write(csr.neighbors, csr.neighbors.length);
  }

  /** Overwrite all positions (stride 4) and reset velocities. */
  setPositions(positions: Float32Array): void {
    this.pos.write(positions, this.n);
    const zeros = new Float32Array(this.n * 4);
    this.vel.write(zeros, this.n);
  }

  setNodePosition(i: number, x: number, y: number, z: number): void {
    const v = this.zeroVec;
    v[0] = x; v[1] = y; v[2] = z; v[3] = 1;
    this.device.queue.writeBuffer(this.pos.buffer, i * 16, v);
    this.device.queue.writeBuffer(this.vel.buffer, i * 16, ZERO4);
  }

  setPinned(i: number, on: boolean): void {
    if (i < 0 || i >= this.n) return;
    this.device.queue.writeBuffer(this.pinned.buffer, i * 4, on ? this.one : this.zero);
  }

  get running(): boolean {
    return this.alpha >= this.settings.alphaMin || this.alphaTarget > 0;
  }

  /** Encode and submit one tick at the current alpha, then cool. */
  tick(): void {
    if (this.n === 0) return;
    const key = `${this.pos.version}.${this.next.version}.${this.vel.version}.${this.pinned.version}.${this.offsets.version}.${this.nbrs.version}`;
    if (!this.bindGroup || key !== this.bindKey) {
      this.bindKey = key;
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.pos.buffer } },
          { binding: 2, resource: { buffer: this.next.buffer } },
          { binding: 3, resource: { buffer: this.vel.buffer } },
          { binding: 4, resource: { buffer: this.pinned.buffer } },
          { binding: 5, resource: { buffer: this.offsets.buffer } },
          { binding: 6, resource: { buffer: this.nbrs.buffer } },
        ],
      });
    }
    const s = this.settings;
    this.alpha += (this.alphaTarget - this.alpha) * s.alphaDecay;
    const rep = repulsionTiles(this.n);
    const u = this.paramU32, f = this.paramF32;
    u[0] = this.n;
    u[1] = rep.tiles;
    u[2] = (this.ticks * rep.tiles) % rep.total;
    u[3] = rep.total;
    u[4] = this.dims;
    f[8] = this.alpha;
    f[9] = s.charge;
    f[10] = rep.scale;
    f[11] = 1; // distanceMin² (d3 distanceMin = 1)
    f[12] = s.linkDistance;
    f[13] = s.linkStrength;
    f[14] = s.gravity;
    f[15] = s.decay;
    f[16] = 200;
    this.device.queue.writeBuffer(this.params, 0, this.paramData);

    const q = this.query && !this.query.busy && this.ticks % 10 === 0 ? this.query : null;
    const enc = this.device.createCommandEncoder({ label: 'layout' });
    const pass = enc.beginComputePass(q ? this.timedPass! : this.plainPass);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.n / TILE));
    pass.end();
    enc.copyBufferToBuffer(this.next.buffer, 0, this.pos.buffer, 0, this.n * 16);
    if (q) {
      enc.resolveQuerySet(q.set, 0, 2, q.resolve, 0);
      enc.copyBufferToBuffer(q.resolve, 0, q.read, 0, 16);
    }
    this.device.queue.submit([enc.finish()]);
    this.ticks++;
    if (q) {
      q.busy = true;
      q.read.mapAsync(GPUMapMode.READ).then(
        () => {
          const t = new BigUint64Array(q.read.getMappedRange());
          const ns = Number(t[1]! - t[0]!);
          q.read.unmap();
          q.busy = false;
          if (ns > 0) this.msPerTick = this.msPerTick ? this.msPerTick * 0.7 + (ns / 1e6) * 0.3 : ns / 1e6;
        },
        () => {
          q.busy = false;
        },
      );
    } else if (!this.query && this.ticks % 10 === 1) {
      const t0 = performance.now();
      this.device.queue.onSubmittedWorkDone().then(() => {
        const ms = performance.now() - t0;
        this.msPerTick = this.msPerTick ? this.msPerTick * 0.7 + ms * 0.3 : ms;
      });
    }
  }

  /** Copy the first `n` positions (stride 4) into `out`, in queue order after all submitted ticks. */
  async readPositions(out: Float32Array, n = this.n): Promise<void> {
    if (n === 0) return;
    const bytes = n * 16;
    let buf = this.staging.pop();
    if (!buf || buf.size < bytes) {
      buf?.destroy();
      buf = this.device.createBuffer({ label: 'layout.readback', size: Math.ceil((bytes * 1.25) / 16) * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    const enc = this.device.createCommandEncoder({ label: 'layout.readback' });
    enc.copyBufferToBuffer(this.pos.buffer, 0, buf, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    try {
      await buf.mapAsync(GPUMapMode.READ, 0, bytes);
      out.set(new Float32Array(buf.getMappedRange(0, bytes)));
      buf.unmap();
      this.staging.push(buf);
    } catch (e) {
      buf.destroy();
      throw e;
    }
  }

  destroy(): void {
    for (const b of [this.pos, this.next, this.vel, this.pinned, this.offsets, this.nbrs]) b.destroy();
    this.params.destroy();
    for (const b of this.staging) b.destroy();
    if (this.query) {
      this.query.set.destroy();
      this.query.resolve.destroy();
      if (!this.query.busy) this.query.read.destroy();
    }
  }
}
