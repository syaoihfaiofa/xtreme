const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const source = fs.readFileSync(
    path.resolve(
        __dirname,
        '../src/packages/pc-render/utils/boxScale.ts',
    ),
    'utf8',
);
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
    },
}).outputText;
const loadedModule = { exports: {} };
new Function('module', 'exports', compiled)(
    loadedModule,
    loadedModule.exports,
);

const {
    getValidWorldUnitsPerPixel,
    isFinitePositiveBoxScale,
} = loadedModule.exports;

assert.strictEqual(getValidWorldUnitsPerPixel(-10, 10, 0), null);
assert.strictEqual(getValidWorldUnitsPerPixel(1, 1, 100), null);
assert.strictEqual(getValidWorldUnitsPerPixel(-10, 10, 100), 0.2);
assert.strictEqual(isFinitePositiveBoxScale({ x: 1, y: 2, z: 3 }), true);
assert.strictEqual(isFinitePositiveBoxScale({ x: 0, y: 2, z: 3 }), false);
assert.strictEqual(isFinitePositiveBoxScale({ x: Infinity, y: 2, z: 3 }), false);
assert.strictEqual(isFinitePositiveBoxScale({ x: NaN, y: 2, z: 3 }), false);

const resizeSource = fs.readFileSync(
    path.resolve(
        __dirname,
        '../src/packages/pc-render/action/ResizeTransAction.ts',
    ),
    'utf8',
);
const editorSource = fs.readFileSync(
    path.resolve(__dirname, '../src/common/Editor.ts'),
    'utf8',
);
assert.match(resizeSource, /getValidWorldUnitsPerPixel/);
assert.match(resizeSource, /isFinitePositiveBoxScale/);
assert.match(editorSource, /checkAnnotationBoxSize/);
assert.doesNotMatch(editorSource, /保存已阻止/);

console.log('box size validation tests passed');
