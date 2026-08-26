const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const source = fs.readFileSync(
    path.resolve(
        __dirname,
        '../src/packages/pc-render/utils/groundPolylineSnap.ts',
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

const { selectHeightContinuousHit } = loadedModule.exports;
const reference = { anchorZ: 0, neighborZs: [0.1, -0.1] };
const roofHit = { distance: 1, point: { z: 3 } };
const groundHit = { distance: 2, point: { z: 0.2 } };

assert.strictEqual(
    selectHeightContinuousHit([roofHit, groundHit], reference),
    groundHit,
);
assert.strictEqual(
    selectHeightContinuousHit([roofHit], reference),
    null,
);
assert.strictEqual(
    selectHeightContinuousHit(
        [{ distance: 1, point: { z: 0.45 } }],
        reference,
    )?.point.z,
    0.45,
);

console.log('curb wall snap tests passed');
