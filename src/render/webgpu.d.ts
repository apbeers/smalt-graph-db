/**
 * The subset of the WebGPU API the renderer uses. TypeScript 5.9's lib.dom does not declare WebGPU,
 * and the project adds no outside packages (such as @webgpu/types) without the owner's yes, so the
 * declarations are written here, following the W3C WebGPU IDL. Remove this file when the TypeScript
 * lib provides them (its declarations would then conflict).
 */

type GPUTextureFormat = string;
type GPUBufferUsageFlags = number;
type GPUTextureUsageFlags = number;
type GPUShaderStageFlags = number;
type GPUMapModeFlags = number;
type GPUSize64 = number;
type GPUCompareFunction = 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';
type GPUBlendFactor =
  | 'zero' | 'one' | 'src' | 'one-minus-src' | 'src-alpha' | 'one-minus-src-alpha' | 'dst' | 'one-minus-dst'
  | 'dst-alpha' | 'one-minus-dst-alpha' | 'src-alpha-saturated' | 'constant' | 'one-minus-constant';
type GPUBlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
type GPULoadOp = 'load' | 'clear';
type GPUStoreOp = 'store' | 'discard';
type GPUPrimitiveTopology = 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';
type GPUFeatureName = string;
type GPUExtent3D = number[] | { width: number; height?: number; depthOrArrayLayers?: number };
type GPUColor = number[] | { r: number; g: number; b: number; a: number };
type GPUBindingResource = GPUSampler | GPUTextureView | GPUBufferBinding;
type GPUAllowSharedBufferSource = ArrayBuffer | SharedArrayBuffer | ArrayBufferView;

interface GPUObjectDescriptorBase {
  label?: string;
}

interface GPU {
  requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance'; forceFallbackAdapter?: boolean }): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

interface GPUSupportedLimits {
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
  readonly maxComputeWorkgroupStorageSize: number;
  readonly [name: string]: number;
}

interface GPUAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

interface GPUAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: GPUSupportedLimits;
  readonly info: GPUAdapterInfo;
  requestDevice(descriptor?: GPUObjectDescriptorBase & {
    requiredFeatures?: GPUFeatureName[];
    requiredLimits?: Record<string, number>;
  }): Promise<GPUDevice>;
}

interface GPUDeviceLostInfo {
  readonly reason: 'unknown' | 'destroyed';
  readonly message: string;
}

interface GPUError {
  readonly message: string;
}

interface GPUDevice extends EventTarget {
  readonly features: ReadonlySet<string>;
  readonly limits: GPUSupportedLimits;
  readonly queue: GPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  destroy(): void;
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
  createSampler(descriptor?: GPUSamplerDescriptor): GPUSampler;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
  createPipelineLayout(descriptor: GPUObjectDescriptorBase & { bindGroupLayouts: GPUBindGroupLayout[] }): GPUPipelineLayout;
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
  createShaderModule(descriptor: GPUObjectDescriptorBase & { code: string }): GPUShaderModule;
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline;
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
  createCommandEncoder(descriptor?: GPUObjectDescriptorBase): GPUCommandEncoder;
  createQuerySet(descriptor: GPUObjectDescriptorBase & { type: 'occlusion' | 'timestamp'; count: number }): GPUQuerySet;
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
  popErrorScope(): Promise<GPUError | null>;
}

interface GPUBufferDescriptor extends GPUObjectDescriptorBase {
  size: GPUSize64;
  usage: GPUBufferUsageFlags;
  mappedAtCreation?: boolean;
}

interface GPUBuffer {
  readonly size: GPUSize64;
  readonly usage: GPUBufferUsageFlags;
  mapAsync(mode: GPUMapModeFlags, offset?: GPUSize64, size?: GPUSize64): Promise<void>;
  getMappedRange(offset?: GPUSize64, size?: GPUSize64): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface GPUTextureDescriptor extends GPUObjectDescriptorBase {
  size: GPUExtent3D;
  format: GPUTextureFormat;
  usage: GPUTextureUsageFlags;
  mipLevelCount?: number;
  sampleCount?: number;
  dimension?: '1d' | '2d' | '3d';
}

interface GPUTexture {
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  createView(descriptor?: GPUObjectDescriptorBase): GPUTextureView;
  destroy(): void;
}

interface GPUTextureView {
  readonly label: string;
}

interface GPUSamplerDescriptor extends GPUObjectDescriptorBase {
  magFilter?: 'nearest' | 'linear';
  minFilter?: 'nearest' | 'linear';
  addressModeU?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
  addressModeV?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
}

interface GPUSampler {
  readonly label: string;
}

interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: GPUShaderStageFlags;
  buffer?: { type?: 'uniform' | 'storage' | 'read-only-storage'; hasDynamicOffset?: boolean; minBindingSize?: GPUSize64 };
  sampler?: { type?: 'filtering' | 'non-filtering' | 'comparison' };
  texture?: { sampleType?: 'float' | 'unfilterable-float' | 'depth' | 'sint' | 'uint'; viewDimension?: '2d'; multisampled?: boolean };
}

interface GPUBindGroupLayoutDescriptor extends GPUObjectDescriptorBase {
  entries: GPUBindGroupLayoutEntry[];
}

interface GPUBindGroupLayout {
  readonly label: string;
}

interface GPUPipelineLayout {
  readonly label: string;
}

interface GPUBufferBinding {
  buffer: GPUBuffer;
  offset?: GPUSize64;
  size?: GPUSize64;
}

interface GPUBindGroupEntry {
  binding: number;
  resource: GPUBindingResource;
}

interface GPUBindGroupDescriptor extends GPUObjectDescriptorBase {
  layout: GPUBindGroupLayout;
  entries: GPUBindGroupEntry[];
}

interface GPUBindGroup {
  readonly label: string;
}

interface GPUShaderModule {
  readonly label: string;
}

interface GPUProgrammableStage {
  module: GPUShaderModule;
  entryPoint?: string;
  constants?: Record<string, number>;
}

interface GPUComputePipelineDescriptor extends GPUObjectDescriptorBase {
  layout: GPUPipelineLayout | 'auto';
  compute: GPUProgrammableStage;
}

interface GPUComputePipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}

interface GPUBlendComponent {
  operation?: GPUBlendOperation;
  srcFactor?: GPUBlendFactor;
  dstFactor?: GPUBlendFactor;
}

interface GPUBlendState {
  color: GPUBlendComponent;
  alpha: GPUBlendComponent;
}

interface GPUColorTargetState {
  format: GPUTextureFormat;
  blend?: GPUBlendState;
  writeMask?: number;
}

interface GPURenderPipelineDescriptor extends GPUObjectDescriptorBase {
  layout: GPUPipelineLayout | 'auto';
  vertex: GPUProgrammableStage;
  fragment?: GPUProgrammableStage & { targets: GPUColorTargetState[] };
  primitive?: { topology?: GPUPrimitiveTopology; cullMode?: 'none' | 'front' | 'back' };
  depthStencil?: { format: GPUTextureFormat; depthWriteEnabled?: boolean; depthCompare?: GPUCompareFunction };
  multisample?: { count?: number };
}

interface GPURenderPipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}

interface GPUQuerySet {
  destroy(): void;
}

interface GPUCommandBuffer {
  readonly label: string;
}

interface GPUComputePassTimestampWrites {
  querySet: GPUQuerySet;
  beginningOfPassWriteIndex?: number;
  endOfPassWriteIndex?: number;
}

interface GPURenderPassColorAttachment {
  view: GPUTextureView;
  clearValue?: GPUColor;
  loadOp: GPULoadOp;
  storeOp: GPUStoreOp;
}

interface GPURenderPassDepthStencilAttachment {
  view: GPUTextureView;
  depthClearValue?: number;
  depthLoadOp?: GPULoadOp;
  depthStoreOp?: GPUStoreOp;
}

interface GPURenderPassDescriptor extends GPUObjectDescriptorBase {
  colorAttachments: GPURenderPassColorAttachment[];
  depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
  timestampWrites?: GPUComputePassTimestampWrites;
}

interface GPUComputePassEncoder {
  setPipeline(pipeline: GPUComputePipeline): void;
  setBindGroup(index: number, group: GPUBindGroup | null): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}

interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, group: GPUBindGroup | null): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  end(): void;
}

interface GPUTexelCopyTextureInfo {
  texture: GPUTexture;
  mipLevel?: number;
  origin?: number[] | { x?: number; y?: number; z?: number };
}

interface GPUTexelCopyBufferLayout {
  offset?: GPUSize64;
  bytesPerRow?: number;
  rowsPerImage?: number;
}

interface GPUCommandEncoder {
  beginComputePass(descriptor?: GPUObjectDescriptorBase & { timestampWrites?: GPUComputePassTimestampWrites }): GPUComputePassEncoder;
  beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
  copyBufferToBuffer(source: GPUBuffer, sourceOffset: GPUSize64, destination: GPUBuffer, destinationOffset: GPUSize64, size: GPUSize64): void;
  copyTextureToBuffer(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyBufferLayout & { buffer: GPUBuffer }, size: GPUExtent3D): void;
  resolveQuerySet(querySet: GPUQuerySet, firstQuery: number, queryCount: number, destination: GPUBuffer, destinationOffset: GPUSize64): void;
  finish(descriptor?: GPUObjectDescriptorBase): GPUCommandBuffer;
}

interface GPUQueue {
  submit(commandBuffers: GPUCommandBuffer[]): void;
  writeBuffer(buffer: GPUBuffer, bufferOffset: GPUSize64, data: GPUAllowSharedBufferSource, dataOffset?: GPUSize64, size?: GPUSize64): void;
  writeTexture(destination: GPUTexelCopyTextureInfo, data: GPUAllowSharedBufferSource, dataLayout: GPUTexelCopyBufferLayout, size: GPUExtent3D): void;
  onSubmittedWorkDone(): Promise<void>;
}

interface GPUCanvasConfiguration {
  device: GPUDevice;
  format: GPUTextureFormat;
  usage?: GPUTextureUsageFlags;
  alphaMode?: 'opaque' | 'premultiplied';
}

interface GPUCanvasContext {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  configure(configuration: GPUCanvasConfiguration): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTexture;
}

interface Navigator {
  /** Absent when the browser has no WebGPU. */
  readonly gpu?: GPU;
}

interface HTMLCanvasElement {
  getContext(contextId: 'webgpu'): GPUCanvasContext | null;
}

declare var GPUBufferUsage: {
  readonly MAP_READ: number;
  readonly MAP_WRITE: number;
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly INDEX: number;
  readonly VERTEX: number;
  readonly UNIFORM: number;
  readonly STORAGE: number;
  readonly INDIRECT: number;
  readonly QUERY_RESOLVE: number;
};

declare var GPUTextureUsage: {
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly TEXTURE_BINDING: number;
  readonly STORAGE_BINDING: number;
  readonly RENDER_ATTACHMENT: number;
};

declare var GPUShaderStage: {
  readonly VERTEX: number;
  readonly FRAGMENT: number;
  readonly COMPUTE: number;
};

declare var GPUMapMode: {
  readonly READ: number;
  readonly WRITE: number;
};
