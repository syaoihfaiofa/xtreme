const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

function loadTsModule(relativePath, requireFn = require) {
    const sourcePath = path.resolve(__dirname, relativePath);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const javascript = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2019,
            resolveJsonModule: true,
            esModuleInterop: true,
        },
    }).outputText;
    const loadedModule = { exports: {} };
    new Function('module', 'exports', 'require', javascript)(
        loadedModule,
        loadedModule.exports,
        requireFn,
    );
    return loadedModule.exports;
}

const jsonConfig = JSON.parse(
    fs.readFileSync(
        path.resolve(__dirname, '../src/config/annotationDataCheck.json'),
        'utf8',
    ),
);
const { buildAnnotationDataCheckConfig } = loadTsModule('../src/config/annotationDataCheckConfig.ts');
const runtimeConfig = buildAnnotationDataCheckConfig(jsonConfig);
const checkConfig = {
    minDim: runtimeConfig.minDim,
    iouThreshold: runtimeConfig.iouThreshold,
};

const {
    checkAnnotationBoxSize,
    checkAnnotationFrameOverlaps,
} = loadTsModule('../src/packages/pc-editor/utils/annotationDataCheck.ts', (request) => {
    if (
        request.endsWith('annotationDataCheck.runtime') ||
        request.endsWith('annotationDataCheckConfig')
    ) {
        return {
            ANNOTATION_DATA_CHECK_CONFIG: runtimeConfig,
            buildAnnotationDataCheckConfig,
        };
    }
    if (request.endsWith('iou')) {
        return loadTsModule('../src/packages/pc-editor/utils/iou.ts');
    }
    if (request === 'pc-render') {
        return {};
    }
    return require(request);
});

function makeBox({ x, y, z, dx, dy, dz, yaw = 0 }) {
    return {
        position: { x, y, z },
        scale: { x: dx, y: dy, z: dz },
        rotation: { z: yaw },
        uuid: `${x}-${y}-${dx}-${dy}`,
    };
}

const normalCar = checkAnnotationBoxSize(makeBox({ x: 0, y: 0, z: 1, dx: 4.5, dy: 1.8, dz: 1.5 }), 'car');
assert.strictEqual(normalCar.length, 0);

const tinyPole = checkAnnotationBoxSize(
    makeBox({ x: 0, y: 0, z: 1, dx: 0.01, dy: 0.01, dz: 2 }),
    'pole',
);
assert.strictEqual(tinyPole.length, 1);
assert.strictEqual(tinyPole[0].code, 'INVALID_SIZE');

const hugeCar = checkAnnotationBoxSize(
    makeBox({ x: 0, y: 0, z: 1, dx: 10, dy: 1.8, dz: 1.5 }),
    'car',
);
assert.strictEqual(hugeCar.length, 1);
assert.strictEqual(hugeCar[0].code, 'SIZE_PRIOR');

const wideCar = checkAnnotationBoxSize(
    makeBox({ x: 0, y: 0, z: 1, dx: 3, dy: 4, dz: 1.5 }),
    'car',
);
assert.strictEqual(wideCar.length, 1);
assert.strictEqual(wideCar[0].code, 'ASPECT');

const hugeRider = checkAnnotationBoxSize(
    makeBox({ x: 0, y: 0, z: 1, dx: 3, dy: 1.0, dz: 2.0 }),
    'Rider',
    checkConfig,
    runtimeConfig,
);
assert.strictEqual(hugeRider.length, 1);
assert.strictEqual(hugeRider[0].code, 'SIZE_PRIOR');
assert.match(hugeRider[0].message, /person/);

const overlapBoxA = makeBox({ x: 0, y: 0, z: 1, dx: 4, dy: 2, dz: 1.6 });
const overlapBoxB = makeBox({ x: 0.5, y: 0, z: 1, dx: 4, dy: 2, dz: 1.6 });
const overlaps = checkAnnotationFrameOverlaps(
    [
        { box: overlapBoxA, className: 'car', trackId: 't1' },
        { box: overlapBoxB, className: 'car', trackId: 't2' },
    ],
    checkConfig,
    runtimeConfig,
);
assert.strictEqual(overlaps.length, 1);
assert.strictEqual(overlaps[0].code, 'OVERLAP');

const skippedOverlap = checkAnnotationFrameOverlaps(
    [
        { box: overlapBoxA, className: 'cone', trackId: 't1' },
        { box: overlapBoxB, className: 'cone', trackId: 't2' },
    ],
    checkConfig,
    runtimeConfig,
);
assert.strictEqual(skippedOverlap.length, 0);

const editorSource = fs.readFileSync(
    path.resolve(__dirname, '../src/common/Editor.ts'),
    'utf8',
);
assert.match(editorSource, /runAutoCheck/);
assert.doesNotMatch(editorSource, /保存已阻止/);
assert.match(
    fs.readFileSync(
        path.resolve(__dirname, '../src/config/annotationDataCheck.json'),
        'utf8',
    ),
    /"iouThreshold": 0.3/,
);

console.log('annotation data check tests passed');
