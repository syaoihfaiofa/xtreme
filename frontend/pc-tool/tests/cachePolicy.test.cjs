const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/packages/pc-editor/common/CachePolicy.ts');
const javascript = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const loaded = new Module(sourcePath);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(javascript, sourcePath);

const { orderEvictionCandidates, canEvict, orderPrefetchIndices } = loaded.exports;
const ordered = orderEvictionCandidates([
  { index: 0, distance: 5, time: 10 },
  { index: 1, distance: 5, time: 5 },
  { index: 2, distance: 8, time: 1, protected: true },
  { index: 3, distance: 4, time: 1, targeted: true },
]);
assert.deepStrictEqual(ordered.map((item) => item.index), [1, 0]);
assert.strictEqual(canEvict({ index: 1, distance: 1, time: 0 }), true);
assert.strictEqual(canEvict({ index: 1, distance: 1, time: 0, protected: true }), false);
assert.deepStrictEqual(orderPrefetchIndices([4, 6, 3, 7], 5, 1), [6, 4, 7, 3]);
assert.deepStrictEqual(orderPrefetchIndices([4, 6, 3, 7], 5, -1), [4, 6, 3, 7]);

const fullLoadSource = path.resolve(__dirname, '../src/packages/pc-editor/common/FullLoadPolicy.ts');
const fullLoadJavascript = ts.transpileModule(fs.readFileSync(fullLoadSource, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const fullLoadModule = new Module(fullLoadSource);
fullLoadModule.filename = fullLoadSource;
fullLoadModule.paths = Module._nodeModulePaths(path.dirname(fullLoadSource));
fullLoadModule._compile(fullLoadJavascript, fullLoadSource);
const { shouldScheduleFullLoad } = fullLoadModule.exports;
assert.strictEqual(shouldScheduleFullLoad({ isCurrentFrame: true, isPlaying: false, hasPreview: true, resourceState: 'preview-ready' }), true);
assert.strictEqual(shouldScheduleFullLoad({ isCurrentFrame: false, isPlaying: false, hasPreview: true, resourceState: 'preview-ready' }), false);
assert.strictEqual(shouldScheduleFullLoad({ isCurrentFrame: true, isPlaying: true, hasPreview: true, resourceState: 'preview-ready' }), false);
assert.strictEqual(shouldScheduleFullLoad({ isCurrentFrame: true, isPlaying: false, hasPreview: false, resourceState: 'preview-ready' }), false);
assert.strictEqual(shouldScheduleFullLoad({ isCurrentFrame: true, isPlaying: false, hasPreview: true, resourceState: 'full-ready' }), false);
console.log('cache policy tests passed');
