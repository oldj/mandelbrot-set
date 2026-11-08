/**
 * The few WebGPU declarations gpu-render.ts uses (TypeScript's DOM library
 * does not declare WebGPU yet): only what it calls, loosely typed.
 */
interface GPUBuffer {
  destroy(): void;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}
interface GPUBindGroupLayout { readonly label: string }
interface GPUBindGroup { readonly label: string }
interface GPUComputePipeline { getBindGroupLayout(index: number): GPUBindGroupLayout }
interface GPUShaderModule { readonly label: string }
interface GPUCommandBuffer { readonly label: string }
interface GPUComputePassEncoder {
  setPipeline(pipeline: GPUComputePipeline): void;
  setBindGroup(index: number, group: GPUBindGroup): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}
interface GPUCommandEncoder {
  beginComputePass(): GPUComputePassEncoder;
  copyBufferToBuffer(source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number): void;
  finish(): GPUCommandBuffer;
}
interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, offset: number, data: BufferSource): void;
  submit(buffers: GPUCommandBuffer[]): void;
  onSubmittedWorkDone(): Promise<void>;
}
interface GPUDevice {
  readonly queue: GPUQueue;
  readonly lost: Promise<unknown>;
  createShaderModule(descriptor: { code: string }): GPUShaderModule;
  createComputePipelineAsync(descriptor: { layout: 'auto'; compute: { module: GPUShaderModule; entryPoint: string } }): Promise<GPUComputePipeline>;
  createBuffer(descriptor: { size: number; usage: number }): GPUBuffer;
  createBindGroup(descriptor: { layout: GPUBindGroupLayout; entries: { binding: number; resource: { buffer: GPUBuffer } }[] }): GPUBindGroup;
  createCommandEncoder(): GPUCommandEncoder;
  addEventListener(type: 'uncapturederror', listener: (event: Event) => void): void;
}
interface GPUUncapturedErrorEvent extends Event { readonly error: { readonly message: string } }
interface GPUAdapter {
  readonly limits: { readonly maxStorageBufferBindingSize: number; readonly maxBufferSize: number };
  requestDevice(descriptor?: { requiredLimits?: Record<string, number> }): Promise<GPUDevice>;
}
interface GPU { requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GPUAdapter | null> }
interface Navigator { readonly gpu?: GPU }
declare const GPUBufferUsage: { readonly MAP_READ: number; readonly COPY_SRC: number; readonly COPY_DST: number; readonly UNIFORM: number; readonly STORAGE: number };
declare const GPUMapMode: { readonly READ: number };
