const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const source = fs.readFileSync(
    path.resolve(
        __dirname,
        '../src/packages/pc-editor/utils/polylineImageBoundaryOcclusion.ts',
    ),
    'utf8',
);
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
        esModuleInterop: true,
    },
}).outputText;
const loadedModule = { exports: {} };
new Function('require', 'module', 'exports', compiled)(
    require,
    loadedModule,
    loadedModule.exports,
);

const { computeImageBoundaryOcclusion } = loadedModule.exports;
const projectionSource = fs.readFileSync(
    path.resolve(
        __dirname,
        '../src/packages/pc-render/utils/polylineProjection.ts',
    ),
    'utf8',
);
const dataManagerSource = fs.readFileSync(
    path.resolve(
        __dirname,
        '../src/packages/pc-editor/common/DataManager.ts',
    ),
    'utf8',
);
assert.doesNotMatch(projectionSource, /MAX_RELEVANT_VIEWS|RELATIVE_SCORE_RATIO/);
assert.match(dataManagerSource, /applyGroundPolylineImageBoundaryOcclusion/);

const point = (x) => ({ x, y: 0, z: 0, clone() { return point(this.x); }, lerp(other, t) {
    return point(this.x + (other.x - this.x) * t);
} });
const result = computeImageBoundaryOcclusion(
    [point(-2), point(2)],
    {},
    [
        {
            key: '0',
            width: 1,
            height: 1,
            project: (value) => ({ x: value.x, y: 0.5 }),
        },
        {
            key: '1',
            width: 10,
            height: 10,
            project: (value) => ({ x: value.x + 5, y: 5 }),
        },
    ],
);

assert.deepStrictEqual(
    result.points.map((value) => {
        const rounded = Math.round(value.x * 1000) / 1000;
        return Object.is(rounded, -0) ? 0 : rounded;
    }),
    [-2, 0, 1, 2],
);
assert.deepStrictEqual(result.segmentVisibleByView['0'], [false, true, false]);
assert.deepStrictEqual(result.segmentVisibleByView['1'], [true, true, true]);

console.log('curb image boundary occlusion tests passed');
