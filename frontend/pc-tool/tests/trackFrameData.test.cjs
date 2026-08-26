const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.resolve(
    __dirname,
    '../src/components/TimeLine/trackFrameData.ts',
);
const source = fs.readFileSync(sourcePath, 'utf8');
const javascript = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
    },
}).outputText;
const loadedModule = new Module(sourcePath);
loadedModule.filename = sourcePath;
loadedModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loadedModule._compile(javascript, sourcePath);

const projection = { userData: { isProjection: true, occluded: undefined } };
const sourceObject = { userData: { occluded: true } };

assert.strictEqual(
    loadedModule.exports.getPrimaryTrackFrameObject([projection, sourceObject]),
    sourceObject,
);
assert.strictEqual(
    loadedModule.exports.getPrimaryTrackFrameObject([projection]),
    projection,
);

console.log('track frame source selection tests passed');
