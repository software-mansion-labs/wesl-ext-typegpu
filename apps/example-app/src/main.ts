/// <reference types="wesl-plugin/suffixes" />

import tgpu from 'typegpu';
import { link } from 'wesl';
import { TestStructImportFromParent } from '../shaders/folder/testImportFromParent.wesl?typegpu';
import linkConfig from '../shaders/main.wesl?link';
import { TestStructAttributes } from '../shaders/testStructsAttributes.wesl?typegpu';
import { TestStructImports } from '../shaders/testStructsImports.wesl?typegpu';
import './style.css';

console.log(TestStructAttributes.propTypes);
console.log(TestStructImports.propTypes);
console.log(TestStructImportFromParent.propTypes);

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Unable to find app!');
}
app.innerHTML = `
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

const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
if (!canvas) {
  throw new Error('Unable to find canvas!');
}
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
  passEncoder.draw(3);
  passEncoder.end();

  device.queue.submit([commandEncoder.finish()]);
}

requestAnimationFrame(() => render());
