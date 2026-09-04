/** WebGPU device acquisition with an honest capability report. */

export type Quality = "high" | "medium" | "low";

export interface GpuInfo {
  vendor: string;
  architecture: string;
  description: string;
  software: boolean;
  timestampQuery: boolean;
}

export interface GpuHandle {
  adapter: GPUAdapter;
  device: GPUDevice;
  info: GpuInfo;
  format: GPUTextureFormat;
}

export function webGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && Boolean(navigator.gpu);
}

export async function acquireGpu(): Promise<GpuHandle | null> {
  if (!webGpuAvailable()) return null;
  const adapter = await navigator.gpu
    .requestAdapter({ powerPreference: "high-performance" })
    .catch(() => null);
  if (!adapter) return null;
  const requiredFeatures: GPUFeatureName[] = [];
  const timestampQuery = adapter.features.has("timestamp-query");
  if (timestampQuery) requiredFeatures.push("timestamp-query");
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ requiredFeatures });
  } catch {
    try {
      device = await adapter.requestDevice();
    } catch {
      return null;
    }
  }
  const raw = (
    adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string; description?: string } }
  ).info;
  const info: GpuInfo = {
    vendor: raw?.vendor ?? "",
    architecture: raw?.architecture ?? "",
    description: raw?.description ?? "",
    software: /swiftshader|llvmpipe|software/i.test(
      `${raw?.vendor} ${raw?.architecture} ${raw?.description}`,
    ),
    timestampQuery: device.features.has("timestamp-query"),
  };
  return { adapter, device, info, format: navigator.gpu.getPreferredCanvasFormat() };
}

/** Software rasterisers get the low tier; the URL can force one for tests (`?quality=low`). */
export function chooseQuality(info: GpuInfo, override: string | null): Quality {
  if (override === "high" || override === "medium" || override === "low") return override;
  return info.software ? "low" : "high";
}
