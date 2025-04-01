/// <reference types="wesl-plugin/suffixes" />

import tgpu from 'typegpu';
import { link } from 'wesl';
import linkConfig from '../shaders/main.wesl?link';
import { TestStruct } from '../shaders/testStructsImports.wesl?typegpu';
import './style.css';

console.log(TestStruct);

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <h1>WESL + TypeGPU</h1>
    <canvas id="canvas" width="600" height="600"></canvas>
  </div>
`;

const root = await tgpu.init();
const device = root.device;

const vertShader = await link({
  ...linkConfig,
  rootModuleName: 'main.wesl',
});

const module = vertShader.createShaderModule(root.device, {});

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
const context = canvas.getContext('webgpu') as GPUCanvasContext;

context.configure({
  device: root.device,
  format: presentationFormat,
  alphaMode: 'premultiplied',
});

const renderPipeline = device.createRenderPipeline({
  vertex: {
    module,
  },
  fragment: {
    module,
    targets: [{ format: presentationFormat }],
  },
  primitive: {
    topology: 'triangle-list',
  },
  layout: device.createPipelineLayout({ bindGroupLayouts: [] }),
});

function render() {
  const textureView = context.getCurrentTexture().createView();
  const renderPassDescriptor: GPURenderPassDescriptor = {
    colorAttachments: [
      {
        view: textureView,
        clearValue: [0, 0, 0, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  };

  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
  passEncoder.setPipeline(renderPipeline);
  // passEncoder.setBindGroup(0, root.unwrap(bindGroup));
  passEncoder.draw(3);
  passEncoder.end();

  device.queue.submit([commandEncoder.finish()]);
}

render();
