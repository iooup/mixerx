import { expect, test } from "@playwright/test";

test("GPU ocean IFFT reconstructs independent 2D cosine and sine fields", async ({ page }) => {
  await page.goto("/stage");
  const result = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const shaderPath = "/src/visuals/gpu/scenes/ocean-shaders.ts";
    const spectrumPath = "/src/visuals/gpu/scenes/ocean-spectrum.ts";
    const { oceanComputeShaders } = await import(/* @vite-ignore */ shaderPath);
    const { ifftStages } = await import(/* @vite-ignore */ spectrumPath);
    device.pushErrorScope("validation");
    const n = 8;
    const data = new Float32Array(n * n * 4);
    data[0] = 0.25;
    data[(2 * n + 1) * 4] = 0.5;
    data[(6 * n + 7) * 4] = 0.5;
    data[(2 * n + 1) * 4 + 3] = -0.5;
    data[(6 * n + 7) * 4 + 3] = 0.5;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    let input = device.createBuffer({ size: data.byteLength, usage });
    let output = device.createBuffer({ size: data.byteLength, usage });
    device.queue.writeBuffer(input, 0, data);
    const module = device.createShaderModule({ code: oceanComputeShaders(n).ifft });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "transform" },
    });
    const encoder = device.createCommandEncoder();
    for (const stage of ifftStages(n)) {
      const params = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(
        params,
        0,
        new Float32Array([stage.size, Number(stage.horizontal), 0, 0, 0, 0, 0, 0]),
      );
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
          { binding: 2, resource: { buffer: params } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1, 1);
      pass.end();
      [input, output] = [output, input];
    }
    const readback = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyBufferToBuffer(input, 0, readback, 0, data.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange());
    let error = 0;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const phase = (2 * Math.PI * (x + 2 * y)) / n;
        const i = (y * n + x) * 4;
        error = Math.max(
          error,
          Math.abs((actual[i] ?? 0) - (0.25 + Math.cos(phase))),
          Math.abs(actual[i + 1] ?? 0),
          Math.abs((actual[i + 2] ?? 0) - Math.sin(phase)),
          Math.abs(actual[i + 3] ?? 0),
        );
      }
    }
    readback.unmap();
    const validation = (await device.popErrorScope())?.message ?? null;
    device.destroy();
    return { error, validation };
  });
  test.skip(!result, "No WebGPU adapter");
  expect(result?.validation).toBeNull();
  expect(result?.error).toBeLessThan(0.00001);
});

for (const quality of ["low", "medium", "high"]) {
  test(`FFT ocean renders, moves and blacks out at ${quality} quality`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.text().includes("[stage] WebGPU")) errors.push(message.text());
    });
    await page.goto(`/stage?demo=1&mode=display&quality=${quality}`);
    const stage = page.getByTestId("stage");
    await expect(stage).toHaveAttribute("data-webgpu", /^(yes|no)$/, { timeout: 30_000 });
    test.skip((await stage.getAttribute("data-webgpu")) !== "yes", "No WebGPU canvas");
    await page.evaluate(() => {
      const hook = (window as unknown as { mixerxStage: { patch(p: unknown): void } }).mixerxStage;
      hook.patch({ sceneId: "intro-lines", follow: false, transition: "cut", photosensitiveSafe: true });
    });
    await expect(stage).toHaveAttribute("data-scene", "intro-lines");
    await page.waitForTimeout(1500);
    const first = await page.getByTestId("stage-canvas").screenshot();
    const luma = await page.evaluate(async () => {
      const hook = (window as unknown as { mixerxStage: { stats(): Promise<{ meanLuma: number }> } })
        .mixerxStage;
      return (await hook.stats()).meanLuma;
    });
    expect(luma).toBeGreaterThan(0.005);
    await page.waitForTimeout(800);
    expect(await page.getByTestId("stage-canvas").screenshot()).not.toEqual(first);
    await page.keyboard.press("Shift+B");
    await page.waitForTimeout(500);
    const black = await page.evaluate(async () => {
      const hook = (window as unknown as { mixerxStage: { stats(): Promise<{ meanLuma: number }> } })
        .mixerxStage;
      return (await hook.stats()).meanLuma;
    });
    expect(black).toBeLessThan(0.004);
    expect(errors).toEqual([]);
  });
}

test("a silent ocean holds its surface with reduced motion enabled", async ({ page }) => {
  await page.goto("/stage?session=ocean-silence-test&mode=display&quality=low");
  const stage = page.getByTestId("stage");
  await expect(stage).toHaveAttribute("data-webgpu", /^(yes|no)$/, { timeout: 30_000 });
  test.skip((await stage.getAttribute("data-webgpu")) !== "yes", "No WebGPU canvas");
  await page.evaluate(() => {
    const hook = (window as unknown as { mixerxStage: { patch(p: unknown): void } }).mixerxStage;
    hook.patch({ sceneId: "intro-lines", follow: false, transition: "cut", reducedMotion: true });
  });
  await expect(stage).toHaveAttribute("data-scene", "intro-lines");
  await page.waitForTimeout(3500);
  const sample = () =>
    page.evaluate(async () => {
      const hook = (
        window as unknown as {
          mixerxStage: {
            stats(): Promise<{ meanLuma: number }>;
            intent(): { audio: { rms: number }; reducedMotion: boolean };
          };
        }
      ).mixerxStage;
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="stage-canvas"]');
      if (!canvas) throw new Error("Missing Stage canvas");
      // Sample after a rendered frame, then compare actual pixels with tolerance for the post-chain dither.
      const stats = await hook.stats();
      const copy = new OffscreenCanvas(256, 144);
      const context = copy.getContext("2d");
      if (!context) throw new Error("Missing pixel readback context");
      context.drawImage(canvas, 0, 0, 256, 144);
      return {
        pixels: Array.from(context.getImageData(0, 0, 256, 144).data),
        luma: stats.meanLuma,
        intent: hook.intent(),
      };
    });
  const before = await sample();
  await page.waitForTimeout(800);
  const after = await sample();
  expect(after.intent.audio.rms).toBe(0);
  expect(after.intent.reducedMotion).toBe(true);
  expect(after.luma).toBeGreaterThan(0.001);
  const changed = after.pixels.filter((value, i) => Math.abs(value - (before.pixels[i] ?? 0)) > 5).length;
  expect(changed / after.pixels.length).toBeLessThan(0.001);
});
