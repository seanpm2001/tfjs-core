/**
 * @license
 * Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {ENV} from '../../environment';
import {Tensor} from '../../tensor';
import {TypedArray} from '../../types';
import * as util from '../../util';

import {GPGPUContext} from './gpgpu_context';
import * as shader_compiler from './shader_compiler';
import {InputInfo, ShapeInfo} from './shader_compiler';
import {TextureData} from './tex_util';

export interface GPGPUProgram {
  variableNames: string[];
  outputShape: number[];
  userCode: string;
  usesPackedTextures?: boolean;
  isPackShader?: boolean;  // This property is used to single out the packing
                           // shader so its output does not get eagerly unpacked
                           // by backend_webgl.compileAndRun.
}

export interface GPGPUBinary {
  webGLProgram: WebGLProgram;
  program: GPGPUProgram;
  uniformLocations: {[name: string]: WebGLUniformLocation};
  source: string;
  inShapeInfos: ShapeInfo[];
  outShapeInfo: ShapeInfo;
  infLoc: WebGLUniformLocation;
  nanLoc: WebGLUniformLocation;
}

export interface TensorData {
  shape: number[];
  texData: TextureData;
  isUniform: boolean;
  // Available when we decide to upload as uniform instead of texture.
  uniformValues?: TypedArray;
}

export function assembleProgramSource(
    program: GPGPUProgram, inputs: TensorData[], output: TensorData) {
  const userCode = program.userCode;

  const inputInfos: InputInfo[] = inputs.map((input, i) => {
    const shapeInfo: ShapeInfo = {
      logicalShape: input.shape,
      texShape: input.isUniform ? null : input.texData.texShape,
      isUniform: input.isUniform,
      isPacked: input.isUniform ? false : input.texData.isPacked,
      flatOffset: null
    };
    if (input.texData != null && input.texData.slice != null &&
        input.texData.slice.flatOffset > 0) {
      shapeInfo.flatOffset = input.texData.slice.flatOffset;
    }
    return {name: program.variableNames[i], shapeInfo};
  });

  const outShapeInfo: ShapeInfo = {
    logicalShape: output.shape,
    texShape: output.texData.texShape,
    isUniform: false,
    isPacked: output.texData.isPacked,
    flatOffset: null
  };

  const {source, key} = shader_compiler.makeShader(
      inputInfos, outShapeInfo, userCode, program.usesPackedTextures);

  return {
    key,
    source,
    inputInfos,
    outShapeInfo,
  };
}

function recordUniformLocations(
    gpgpu: GPGPUContext, webGLProgram: WebGLProgram,
    uniformLocations: {[name: string]: WebGLUniformLocation},
    shouldThrow: boolean, varNames: string[]) {
  for (let i = 0; i < varNames.length; i++) {
    const varName = varNames[i];
    const varLocation =
        gpgpu.getUniformLocation(webGLProgram, varName, shouldThrow);
    if (varLocation != null) {
      uniformLocations[varName] = varLocation;
    }
  }
}

export function compileProgram<T extends Tensor, K extends Tensor>(
    gpgpu: GPGPUContext, program: GPGPUProgram, inputs: TensorData[],
    output: TensorData): GPGPUBinary {
  const {source, inputInfos, outShapeInfo} =
      assembleProgramSource(program, inputs, output);
  const webGLProgram = gpgpu.createProgram(source);

  // Add special uniforms (NAN, INFINITY)
  let infLoc: WebGLUniformLocation = null;
  const nanLoc = gpgpu.getUniformLocation(webGLProgram, 'NAN', false);
  if (ENV.getNumber('WEBGL_VERSION') === 1) {
    infLoc = gpgpu.getUniformLocation(webGLProgram, 'INFINITY', false);
  }

  // Add user-defined uniforms
  const uniformLocations: {[name: string]: WebGLUniformLocation} = {};
  for (let i = 0; i < program.variableNames.length; i++) {
    const varName = program.variableNames[i];
    const shouldThrow = false;
    uniformLocations[varName] =
        gpgpu.getUniformLocation(webGLProgram, varName, shouldThrow);
    uniformLocations[`offset${varName}`] =
        gpgpu.getUniformLocation(webGLProgram, `offset${varName}`, shouldThrow);
  }

  // Record uniform locations for input shapes;
  for (let i = 0; i < inputInfos.length; i++) {
    const inputInfo = inputInfos[i];
    const inShapeInfo = inputInfo.shapeInfo;

    if (inShapeInfo.logicalShape.length > 0) {
      const shouldThrow = false;
      recordUniformLocations(
          gpgpu, webGLProgram, uniformLocations, shouldThrow, [
            `shape${inputInfo.name}`,
            `texShape${inputInfo.name}`,
            `strides${inputInfo.name}`,
            `packedTexShape${inputInfo.name}`,
            `valuesPerRow${inputInfo.name}`,
            `texelsInBatch${inputInfo.name}`,
          ]);
    }
  }

  // Record location of uniforms for output
  if (outShapeInfo.logicalShape.length > 0) {
    const shouldThrow = false;
    recordUniformLocations(gpgpu, webGLProgram, uniformLocations, shouldThrow, [
      'outputShape',
      'outputStrides',
      'outputTexShape',
      'outputPackedTexShape',
      'outputTexelsInLogicalRow',
      'outputTexelsInBatch',
    ]);
  }

  const inShapeInfos = inputInfos.map(x => x.shapeInfo);

  return {
    program,
    source,
    webGLProgram,
    uniformLocations,
    inShapeInfos,
    outShapeInfo,
    infLoc,
    nanLoc,
  };
}

// TODO(yassogba) update/remove this
function validateBinaryAndProgram(
    shapeInfos: ShapeInfo[], inputs: TensorData[]) {
  if (shapeInfos.length !== inputs.length) {
    throw Error(
        `Binary was compiled with ${shapeInfos.length} inputs, but ` +
        `was executed with ${inputs.length} inputs`);
  }

  shapeInfos.forEach((s, i) => {
    const shapeA = s.logicalShape;
    const input = inputs[i];
    const shapeB = input.shape;

    if (!util.arraysEqual(shapeA, shapeB)) {
      throw Error(
          `Binary was compiled with different shapes than ` +
          `the current args. Shapes ${shapeA} and ${shapeB} must match`);
    }
    // The input is uploaded as uniform.
    if (s.isUniform && input.isUniform) {
      return;
    }

    const texShapeA = s.texShape;
    const texShapeB = input.isUniform ? null : input.texData.texShape;
    if (!util.arraysEqual(texShapeA, texShapeB)) {
      throw Error(
          `Binary was compiled with different texture shapes than the` +
          ` current args. Shape ${texShapeA} and ${texShapeB} must match`);
    }
  });
}

// function uploadUniform1iv(
//     gpgpu: GPGPUContext, binary: GPGPUBinary, uniformName: string,
//     values: () => number[] | Int32Array) {
//   const varLoc = binary.uniformLocations[uniformName];
//   if (varLoc != null) {
//     let vals: number[]|Int32Array = values();
//     if (!(vals instanceof Int32Array)) {
//       vals = new Int32Array(vals);
//     }
//     gpgpu.gl.uniform1iv(varLoc, vals);
//   }
// }

// function uploadUniform1i(
//     gpgpu: GPGPUContext, binary: GPGPUBinary, uniformName: string,
//     values: () => number) {
//   const varLoc = binary.uniformLocations[uniformName];
//   if (varLoc != null) {
//     const val = values();
//     gpgpu.gl.uniform1i(varLoc, val);
//   }
// }

function uploadUniform1ivVals(
    gpgpu: GPGPUContext, binary: GPGPUBinary, uniformName: string,
    values: number[]|Int32Array) {
  const varLoc = binary.uniformLocations[uniformName];
  if (varLoc != null) {
    let vals: number[]|Int32Array = values;
    if (!(vals instanceof Int32Array)) {
      vals = new Int32Array(vals);
    }
    gpgpu.gl.uniform1iv(varLoc, vals);
  }
}

function uploadUniform1iVals(
    gpgpu: GPGPUContext, binary: GPGPUBinary, uniformName: string,
    values: number) {
  const varLoc = binary.uniformLocations[uniformName];
  if (varLoc != null) {
    const val = values;
    gpgpu.gl.uniform1i(varLoc, val);
  }
}

export function runProgram<T extends Tensor, K extends Tensor>(
    gpgpu: GPGPUContext, binary: GPGPUBinary, inputs: TensorData[],
    output: TensorData,
    customSetup?: (gpgpu: GPGPUContext, webGLProgram: WebGLProgram) =>
        void): void {
  // TODO(yassogba) update this/determine what to validate after new
  // key gets in.
  validateBinaryAndProgram(binary.inShapeInfos, inputs);
  validateBinaryAndProgram([binary.outShapeInfo], [output]);

  const outTex = output.texData.texture;
  const outTexShape = output.texData.texShape;
  if (output.texData.isPacked) {
    gpgpu.setOutputPackedMatrixTexture(outTex, outTexShape[0], outTexShape[1]);
  } else {
    gpgpu.setOutputMatrixTexture(outTex, outTexShape[0], outTexShape[1]);
  }
  gpgpu.setProgram(binary.webGLProgram);

  // Set special uniforms (NAN, INFINITY)
  if (ENV.getNumber('WEBGL_VERSION') === 1) {
    if (binary.infLoc !== null) {
      gpgpu.gl.uniform1f(binary.infLoc, Infinity);
    }
  }
  if (binary.nanLoc !== null) {
    gpgpu.gl.uniform1f(binary.nanLoc, NaN);
  }

  // Set user-defined inputs
  inputs.forEach((input, i) => {
    const varName = binary.program.variableNames[i];
    const varLoc = binary.uniformLocations[varName];

    if (varLoc == null) {
      // The compiler inferred that this variable is not used in this shader.
      return;
    }

    if (input.isUniform) {
      // Upload the values of the tensor as uniform.
      if (util.sizeFromShape(input.shape) < 2) {
        gpgpu.gl.uniform1f(varLoc, input.uniformValues[0]);
      } else {
        let vals = input.uniformValues;
        if (!(vals instanceof Float32Array)) {
          vals = new Float32Array(vals);
        }
        gpgpu.gl.uniform1fv(varLoc, vals);
      }
      return;
    }

    // Compute shape here as it is used in a number of uniforms
    let shape: number[];
    if (binary.program.usesPackedTextures) {
      shape = util.packedShapeTransform(input.shape);
    } else {
      // Call squeezeShape to match the shape used in the shader program
      const {newShape} = util.squeezeShape(input.shape);
      shape = newShape;
    }

    uploadUniform1ivVals(gpgpu, binary, `shape${varName}`, shape);
    uploadUniform1ivVals(
        gpgpu, binary, `strides${varName}`, util.computeStrides(shape));

    // TODO(yassogba, nsthoat) rename/document these two shapes:
    // input.texData.shape and input.texData.texShape
    // to make it more apparent why they are both needed.
    uploadUniform1ivVals(
        gpgpu, binary, `texShape${varName}`, input.texData.texShape);

    const texShape = input.texData.texShape;
    const packedTexShape =
        [Math.ceil(texShape[0] * 0.5), Math.ceil(texShape[1] * 0.5)];
    uploadUniform1ivVals(
        gpgpu, binary, `packedTexShape${varName}`, packedTexShape);

    const rank = shape.length;
    const valuesPerRow = Math.ceil(shape[rank - 1] * 0.5);
    uploadUniform1iVals(gpgpu, binary, `valuesPerRow${varName}`, valuesPerRow);

    const texelsInBatch = valuesPerRow * Math.ceil(shape[rank - 2] * 0.5);
    uploadUniform1iVals(
        gpgpu, binary, `texelsInBatch${varName}`, texelsInBatch);

    // If the input was sliced, upload the flat offset index.
    if (input.texData.slice != null) {
      uploadUniform1iVals(
          gpgpu, binary, `offset${varName}`, input.texData.slice.flatOffset);
    }

    gpgpu.setInputMatrixTexture(input.texData.texture, varLoc, i);
  });

  // Upload output shape uniforms
  if (output.shape.length > 0) {
    const outputShape = output.shape;
    uploadUniform1ivVals(gpgpu, binary, 'outputShape', outputShape);

    uploadUniform1ivVals(
        gpgpu, binary, 'outputStrides', util.computeStrides(outputShape));

    // TODO(yassogba, nsthoat) rename/document these two shapes:
    // output.texData.shape and output.texData.texShape
    // to make it more apparent why they are both needed.
    const outputTexShape = output.texData.texShape;
    uploadUniform1ivVals(gpgpu, binary, 'outputTexShape', outputTexShape);

    // TODO yassogba found out why having the conditional below causes errors
    // it appears that there are programs for which this check is false but
    // outputPackedTexShape is needed.
    // if (binary.program.usesPackedTextures) {

    const outputPackedTexShape = [
      Math.ceil(outputTexShape[0] * 0.5), Math.ceil(outputTexShape[1] * 0.5)
    ];
    uploadUniform1ivVals(
        gpgpu, binary, 'outputPackedTexShape', outputPackedTexShape);
    // }

    const rank = outputShape.length;
    const outputTexelsInLogicalRow = Math.ceil(outputShape[rank - 1] * 0.5);
    uploadUniform1iVals(
        gpgpu, binary, 'outputTexelsInLogicalRow', outputTexelsInLogicalRow);

    const outputTexelsInBatch =
        outputTexelsInLogicalRow * Math.ceil(outputShape[rank - 2] * 0.5);
    uploadUniform1iVals(
        gpgpu, binary, 'outputTexelsInBatch', outputTexelsInBatch);
  }

  if (customSetup != null) {
    customSetup(gpgpu, binary.webGLProgram);
  }
  gpgpu.executeProgram();
}

export function makeShaderKey(
    program: GPGPUProgram, inputs: TensorData[], output: TensorData): string {
  let keyInputs = '';
  inputs.concat(output).forEach(x => {
    const hasOffset = x.texData != null && x.texData.slice != null &&
        x.texData.slice.flatOffset > 0;
    const texShape = x.isUniform ? 'uniform' : x.texData.texShape;
    keyInputs += `${x.shape}_${texShape}_${hasOffset}`;
  });
  const keyUserCode = program.userCode;
  let key = program.constructor.name;
  // Fast string concat. See https://jsperf.com/string-concatenation/14.
  key += '_' + keyInputs + '_' + keyUserCode;
  return key;
}

// export function makeShaderKeyWhole(
//     program: GPGPUProgram, inputs: TensorData[], output: TensorData) {
//   const {key} = assembleProgramSource(program, inputs, output);
//   let keyInputs = '';
//   inputs.concat(output).forEach(x => {
//     const hasOffset = x.texData != null && x.texData.slice != null &&
//         x.texData.slice.flatOffset > 0;
//     // hasOffset needs to be in te key because offset is always added as a
//     // uniform to the source whether or not it is acutally used and thus the
//     // uniform location may get cached as null on first invocation if we
//     didn't
//     // have this here. This results in  future invocations with a sliced
//     tensor
//     // colliding with an incompatible program in the cache. This could be
//     // removed if the offset uniform and location were not added to the
//     program
//     // at compile if it is not used.
//     keyInputs += `_${hasOffset}`;
//   });
//   // Progname is added for debugging convenience.
//   const progName = program.constructor.name;
//   return progName + '_' + keyInputs + '_' + key;
// }
