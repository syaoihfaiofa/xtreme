const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.resolve(
    __dirname,
    '../src/components/Instance/classGroupKey.ts',
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

const { getClassGroupKey } = loadedModule.exports;

assert.strictEqual(
    getClassGroupKey('annotation', 12, 'bike'),
    getClassGroupKey('annotation', 12, 'bicycle'),
);
assert.notStrictEqual(
    getClassGroupKey('annotation', 12, 'bike'),
    getClassGroupKey('annotation', 13, 'bike'),
);
assert.notStrictEqual(
    getClassGroupKey('annotation', undefined, 'bike'),
    getClassGroupKey('annotation', undefined, 'car'),
);

console.log('instance class group key tests passed');
