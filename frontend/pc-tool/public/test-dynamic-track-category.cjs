const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const source = fs.readFileSync(
    path.resolve(
        __dirname,
        '../src/packages/pc-editor/utils/trackingMetadata.ts',
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

const { getTrackingMetadata } = loadedModule.exports;
const sourceUserData = {
    trackId: 'track-1',
    trackName: 'person-1',
    classId: '12',
    classType: 'Person',
    attrs: { pose: 'standing' },
    motionMode: 'DYNAMIC_VARIABLE_SIZE',
    syncUseZ: true,
    confidence: 0.99,
    backId: 'source-row',
};
const metadata = getTrackingMetadata(sourceUserData);

assert.deepStrictEqual(metadata.attrs, { pose: 'standing' });
assert.strictEqual(metadata.classId, '12');
assert.strictEqual(metadata.classType, 'Person');
assert.strictEqual(metadata.trackId, 'track-1');
assert.strictEqual(metadata.motionMode, 'DYNAMIC_VARIABLE_SIZE');
assert.strictEqual(metadata.confidence, undefined);
assert.strictEqual(metadata.backId, undefined);

sourceUserData.attrs.pose = 'walking';
assert.strictEqual(metadata.attrs.pose, 'standing');

const trackingDataSource = fs.readFileSync(
    path.resolve(
        __dirname,
        '../src/packages/pc-editor/utils/data.ts',
    ),
    'utf8',
);
assert.match(trackingDataSource, /sourceUserDataByTrackId/);
assert.match(trackingDataSource, /existMap\[trackId\]/);
assert.match(
    trackingDataSource,
    /updateUserData = sourceMetadata[\s\S]*getTrackingMetadata\(sourceMetadata\)/,
);

console.log('dynamic tracking category tests passed');
