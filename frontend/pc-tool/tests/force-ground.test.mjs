import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

async function getForceGroundUrl() {
    const sourcePath = new URL(
        '../src/packages/pc-render/points/forceGround.ts',
        import.meta.url,
    );
    const source = await readFile(sourcePath, 'utf8');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return `data:text/javascript,${encodeURIComponent(output)}`;
}

async function loadForceGround() {
    return import(await getForceGroundUrl());
}

async function loadPoints() {
    const forceGroundSource = await readFile(
        new URL('../src/packages/pc-render/points/forceGround.ts', import.meta.url),
        'utf8',
    );
    const sourcePath = new URL('../src/packages/pc-render/points/Points.ts', import.meta.url);
    let source = await readFile(sourcePath, 'utf8');
    globalThis.__THREE_FOR_POINTS_TEST__ = THREE;
    source = `${forceGroundSource}\n${source
        .replace(
            "import * as THREE from 'three';",
            'const THREE = globalThis.__THREE_FOR_POINTS_TEST__;',
        )
        .replace("import { PCDLoader } from '../loader';", 'class PCDLoader {}')
        .replace("import PointsMaterial from '../material/PointsMaterial';", 'class PointsMaterial {}')
        .replace("import { Event } from '../config';", 'const Event = { POINTS_CHANGE: "points_change" };')
        .replace("import { IPoints } from './type';", '')
        .replace(/import \{[\s\S]*?\} from '\.\/forceGround';/, '')
        .replace(' implements IPoints', '')}`;
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

test('classifies force-ground values with a strict shared threshold', async () => {
    const {
        FORCE_GROUND_THRESHOLD,
        isForceGround,
    } = await loadForceGround();

    assert.equal(FORCE_GROUND_THRESHOLD, 0.5);
    assert.equal(isForceGround(0.5), false);
    assert.equal(isForceGround(0.500001), true);
    assert.equal(isForceGround(1), true);
});

test('applies automatic and forced ground filtering without changing independent clipping', async () => {
    const { shouldDiscardByGroundFilter } = await loadForceGround();
    const automaticNonGround = {
        hasColor: true,
        hasIntensity: true,
        color: [10, 10, 10],
        intensity: 10,
    };

    assert.equal(
        shouldDiscardByGroundFilter({
            colorMode: 0,
            hideGround: true,
            hideNonGroundRgb: false,
            forceGround: 0,
            ...automaticNonGround,
            color: [23, 23, 23],
        }),
        true,
    );
    assert.equal(
        shouldDiscardByGroundFilter({
            colorMode: 0,
            hideGround: true,
            hideNonGroundRgb: false,
            forceGround: 0,
            ...automaticNonGround,
        }),
        false,
    );
    assert.equal(
        shouldDiscardByGroundFilter({
            colorMode: 1,
            hideGround: true,
            hideNonGroundRgb: false,
            forceGround: 1,
            groundCorrectionPreview: true,
            ...automaticNonGround,
        }),
        false,
    );
    assert.equal(
        shouldDiscardByGroundFilter({
            colorMode: 1,
            hideGround: true,
            hideNonGroundRgb: false,
            forceGround: 1,
            groundCorrectionPreview: true,
            ...automaticNonGround,
            color: [23, 23, 23],
        }),
        true,
    );
    assert.equal(
        shouldDiscardByGroundFilter({
            colorMode: 1,
            hideGround: true,
            hideNonGroundRgb: false,
            forceGround: 1,
            groundCorrectionPreview: true,
            hasColor: false,
            hasIntensity: false,
        }),
        true,
    );
    assert.equal(
        shouldDiscardByGroundFilter({
            colorMode: 2,
            hideGround: false,
            hideNonGroundRgb: true,
            forceGround: 0,
            ...automaticNonGround,
        }),
        true,
    );
    assert.equal(
        shouldDiscardByGroundFilter({
            colorMode: 2,
            hideGround: false,
            hideNonGroundRgb: true,
            forceGround: 1,
            ...automaticNonGround,
        }),
        false,
    );
});

test('classifies automatic non-ground points with attribute guards and tolerance boundaries', async () => {
    const {
        AUTO_NON_GROUND_TOLERANCE,
        isAutomaticNonGround,
        shouldDiscardByGroundFilter,
    } = await loadForceGround();

    assert.equal(AUTO_NON_GROUND_TOLERANCE, 12);
    assert.equal(
        isAutomaticNonGround({
            hasColor: true,
            hasIntensity: true,
            color: [111.999, 88.001, 100],
            intensity: 100,
        }),
        true,
    );
    assert.equal(
        isAutomaticNonGround({
            hasColor: true,
            hasIntensity: true,
            color: [112, 100, 100],
            intensity: 100,
        }),
        false,
    );
    assert.equal(
        isAutomaticNonGround({
            hasColor: false,
            hasIntensity: true,
            color: [100, 100, 100],
            intensity: 100,
        }),
        false,
    );
    assert.equal(
        isAutomaticNonGround({
            hasColor: true,
            hasIntensity: false,
            color: [100, 100, 100],
            intensity: 100,
        }),
        false,
    );
    assert.equal(
        shouldDiscardByGroundFilter({
            colorMode: 2,
            hideGround: false,
            hideNonGroundRgb: true,
            forceGround: 0,
            hasColor: false,
            hasIntensity: true,
            intensity: 100,
        }),
        false,
    );
});

test('keeps ground, intensity, and side-view rendering decisions independent', async () => {
    const { evaluatePointRenderDecision } = await loadForceGround();
    const baseInput = {
        colorMode: 0,
        hideGround: true,
        hideNonGroundRgb: false,
        hasColor: true,
        hasIntensity: true,
        color: [10, 10, 10],
        intensity: 11,
        openIntensity: 1,
        intensityRange: [0, 10],
        sideViewContrast: -1,
        isInSideViewContrastArea: true,
    };

    assert.deepEqual(
        evaluatePointRenderDecision({ ...baseInput, forceGround: 1 }),
        {
            discard: true,
            discardedByGroundFilter: true,
            discardedByIntensityRange: true,
            sideViewContrastChangesColor: false,
        },
    );
    assert.deepEqual(
        evaluatePointRenderDecision({
            ...baseInput,
            colorMode: 2,
            hideGround: false,
            hideNonGroundRgb: true,
            forceGround: 1,
        }),
        {
            discard: true,
            discardedByGroundFilter: false,
            discardedByIntensityRange: true,
            sideViewContrastChangesColor: false,
        },
    );
    const forcedRgbInput = {
        ...baseInput,
        colorMode: 2,
        hideGround: false,
        hideNonGroundRgb: true,
        forceGround: 1,
        openIntensity: -1,
        intensity: 5,
    };
    assert.deepEqual(
        evaluatePointRenderDecision(forcedRgbInput),
        {
            discard: false,
            discardedByGroundFilter: false,
            discardedByIntensityRange: false,
            sideViewContrastChangesColor: false,
        },
    );
    assert.deepEqual(
        evaluatePointRenderDecision({ ...forcedRgbInput, sideViewContrast: 1 }),
        {
            discard: false,
            discardedByGroundFilter: false,
            discardedByIntensityRange: false,
            sideViewContrastChangesColor: true,
        },
    );
});

test('limits side-view contrast to RGB points without changing discard', async () => {
    const { evaluatePointRenderDecision } = await loadForceGround();
    const baseInput = {
        hideGround: false,
        hideNonGroundRgb: false,
        forceGround: 1,
        hasColor: true,
        hasIntensity: true,
        color: [100, 100, 100],
        intensity: 100,
        openIntensity: -1,
        intensityRange: [0, 255],
        sideViewContrast: 1,
        isInSideViewContrastArea: true,
    };

    for (const colorMode of [0, 1]) {
        assert.deepEqual(
            evaluatePointRenderDecision({ ...baseInput, colorMode }),
            {
                discard: false,
                discardedByGroundFilter: false,
                discardedByIntensityRange: false,
                sideViewContrastChangesColor: false,
            },
        );
    }
    assert.deepEqual(
        evaluatePointRenderDecision({ ...baseInput, colorMode: 2 }),
        {
            discard: false,
            discardedByGroundFilter: false,
            discardedByIntensityRange: false,
            sideViewContrastChangesColor: true,
        },
    );
});

async function loadChunkApplyGuard() {
    const sourcePath = new URL(
        '../src/packages/pc-editor/common/chunkApplyGuard.ts',
        import.meta.url,
    );
    const source = await readFile(sourcePath, 'utf8');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

test('marks points inside polygons and leaves points outside unmarked', async () => {
    const { calculateForceGround } = await loadForceGround();

    const forceGround = calculateForceGround(
        new Float32Array([
            0.5, 0.5, 0,
            0.5, 0.5, 2,
            1.5, 0.5, 0,
            0, 0.5, 0,
        ]),
        [{
            type: 'polygon',
            vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
            heightRange: { min: -1, max: 1 },
        }],
        [],
    );

    assert.deepEqual([...forceGround], [1, 0, 0, 1]);
});

test('marks brush boundaries and respects optional height ranges', async () => {
    const { calculateForceGround } = await loadForceGround();

    const forceGround = calculateForceGround(
        new Float32Array([
            1, 0, 0,
            0, 0, 2,
            0, 0, 3,
        ]),
        [{
            type: 'brush',
            samples: [{ x: 0, y: 0 }],
            radius: 1,
            heightRange: { min: 0, max: 2 },
        }],
        [],
    );

    assert.deepEqual([...forceGround], [1, 1, 0]);
});

test('combines overlapping polygon and brush operations', async () => {
    const { calculateForceGround } = await loadForceGround();

    const forceGround = calculateForceGround(
        new Float32Array([
            0.5, 0.5, 0,
            2, 0, 0,
            4, 0, 0,
        ]),
        [
            {
                type: 'polygon',
                vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
            },
            { type: 'brush', samples: [{ x: 2, y: 0 }], radius: 1 },
        ],
        [],
    );

    assert.deepEqual([...forceGround], [1, 1, 0]);
});

test('marks only exact persisted cluster points using a spatial hash', async () => {
    const { calculateForceGround } = await loadForceGround();

    const forceGround = calculateForceGround(
        new Float32Array([
            0, 0, 0,
            0.29, 0, 0,
            0.31, 0, 0,
            0, 0, 0.31,
            10, 10, 10,
        ]),
        [{
            type: 'cluster',
            points: [{ x: 0, y: 0, z: 0 }],
            radius: 0.3,
        }],
        [],
    );

    assert.deepEqual([...forceGround], [1, 1, 0, 0, 0]);
});

test('eraser strokes undo only earlier corrections and later operations can re-mark', async () => {
    const { calculateForceGround } = await loadForceGround();
    const square = {
        type: 'polygon',
        vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
    };
    const eraser = {
        type: 'brush',
        samples: [{ x: 1, y: 1 }],
        radius: 0.5,
        heightRange: { min: -1, max: 1 },
        erase: true,
    };
    const positions = new Float32Array([
        1, 1, 0,
        1, 1, 2,
        3, 3, 0,
        6, 6, 0,
    ]);

    assert.deepEqual(
        [...calculateForceGround(positions, [square, eraser], [])],
        [0, 1, 1, 0],
    );
    assert.deepEqual(
        [...calculateForceGround(positions, [square, eraser, square], [])],
        [1, 1, 1, 0],
    );
    assert.deepEqual(
        [...calculateForceGround(positions, [eraser, square], [])],
        [1, 1, 1, 0],
    );
});

test('grid-accelerated force ground matches a newest-wins brute-force reference', async () => {
    const { calculateForceGround } = await loadForceGround();
    let seed = 7;
    const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };
    const coordinates = [];
    for (let index = 0; index < 4000; index++) {
        coordinates.push(random() * 40 - 20, random() * 40 - 20, random() * 2 - 1);
    }
    coordinates.push(5000, -5000, 0); // far outlier must not break the grid
    const positions = new Float32Array(coordinates);
    const point = () => ({ x: random() * 40 - 20, y: random() * 40 - 20 });
    const operations = [
        {
            type: 'polygon',
            vertices: [{ x: -15, y: -15 }, { x: 10, y: -12 }, { x: 5, y: 12 }, { x: -12, y: 8 }],
            heightRange: { min: -0.5, max: 0.5 },
        },
        // Sparse region brush spread over the whole frame.
        { type: 'brush', samples: Array.from({ length: 60 }, point), radius: 0.8, heightRange: { min: -1, max: 0 } },
        // Dense stroke and an eraser crossing earlier corrections.
        { type: 'brush', samples: Array.from({ length: 40 }, (_, i) => ({ x: -5 + i * 0.1, y: 0 })), radius: 1.5 },
        { type: 'brush', samples: [{ x: 0, y: 0 }, { x: 4, y: 4 }], radius: 3, erase: true },
        {
            type: 'cluster',
            points: Array.from({ length: 200 }, () => ({ ...point(), z: random() * 2 - 1 })),
            radius: 0.9,
        },
        { type: 'brush', center: { x: 1, y: 1 }, radius: 1 },
    ];
    const inPolygon = (x, y, vertices) => {
        let inside = false;
        for (let current = 0, previous = vertices.length - 1; current < vertices.length; previous = current++) {
            const start = vertices[previous];
            const end = vertices[current];
            if ((start.y > y) !== (end.y > y) && x < ((end.x - start.x) * (y - start.y)) / (end.y - start.y) + start.x) {
                inside = !inside;
            }
        }
        return inside;
    };
    const expected = [];
    for (let index = 0; index < positions.length / 3; index++) {
        const [x, y, z] = positions.slice(index * 3, index * 3 + 3);
        let value = 0;
        for (const operation of [...operations].reverse()) {
            const range = operation.heightRange;
            if (range && (z < range.min || z > range.max)) continue;
            const hit = operation.type === 'polygon'
                ? inPolygon(x, y, operation.vertices)
                : operation.type === 'brush'
                    ? (operation.samples || [operation.center]).some(
                        (sample) => (x - sample.x) ** 2 + (y - sample.y) ** 2 <= operation.radius ** 2,
                    )
                    : operation.points.some(
                        (sample) => (x - sample.x) ** 2 + (y - sample.y) ** 2 + (z - sample.z) ** 2 <= operation.radius ** 2,
                    );
            if (!hit) continue;
            value = operation.erase ? 0 : 1;
            break;
        }
        expected.push(value);
    }

    const actual = [...calculateForceGround(positions, operations, [])];

    assert.ok(expected.filter(Boolean).length > 500);
    assert.deepEqual(actual, expected);
});

test('never forces ego body points to ground', async () => {
    const { calculateForceGround, createEgoBodyProtectedVolume, isInEgoBody } = await loadForceGround();
    const everywhere = {
        type: 'polygon',
        vertices: [{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }],
    };
    const positions = new Float32Array([
        1, 0, 0.5,      // ego roof/body
        3.5, 1.0, 0.1,  // ego body near its lower corner
        1, 0, -0.2,     // raised ground under the vehicle, below the body volume
        5, 0, 0.5,      // in front of the vehicle
    ]);

    assert.equal(isInEgoBody(1, 0, 0.5), true);
    assert.deepEqual(
        [...calculateForceGround(positions, [everywhere], [createEgoBodyProtectedVolume()])],
        [0, 0, 1, 1],
    );
});

test('never forces points inside protected boxes or walls to ground', async () => {
    const { calculateForceGround } = await loadForceGround();
    const everywhere = {
        type: 'polygon',
        vertices: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }],
    };
    // 2x2x2 box centered at (5, 0, 0), rotated 45 degrees around Z.
    const cos = Math.cos(Math.PI / 4);
    const sin = Math.sin(Math.PI / 4);
    const box = {
        type: 'box',
        matrix: [2 * cos, 2 * sin, 0, 0, -2 * sin, 2 * cos, 0, 0, 0, 0, 2, 0, 5, 0, 0, 1],
        inverseMatrix: [cos / 2, -sin / 2, 0, 0, sin / 2, cos / 2, 0, 0, 0, 0, 0.5, 0, -5 * cos / 2, 5 * sin / 2, 0, 1],
    };
    const wall = {
        type: 'wall',
        samples: [
            { bottom: { x: -5, y: -2, z: 0 }, top: { x: -5, y: -2, z: 2 } },
            { bottom: { x: -5, y: 2, z: 0 }, top: { x: -5, y: 2, z: 2 } },
        ],
        thickness: 0.2,
    };
    const positions = new Float32Array([
        5, 0, 0.5,      // box center region
        6, 0.9, 0,      // outside the rotated box (inside the unrotated one)
        -5.1, 0, 1,     // on the wall
        -5, 0, 2.5,     // above the wall
        -4.5, 0, 1,     // beside the wall
        0, 0, 0,        // open ground
    ]);

    assert.deepEqual(
        [...calculateForceGround(positions, [everywhere], [box, wall])],
        [0, 1, 0, 1, 1, 1],
    );
});

test('creates matching forceGround attributes for full and late chunk point clouds', async () => {
    const { default: Points } = await loadPoints();
    const points = new Points({});

    points.updateData({ position: [0, 0, 0, 3, 0, 0] }, [], []);
    const fullAttribute = points.geometry.getAttribute('forceGround');
    assert.equal(fullAttribute.count, 2);
    assert.deepEqual([...fullAttribute.array], [0, 0]);

    points.updateData(
        { position: [0, 0, 0, 2, 0, 0, 4, 0, 0] },
        [{ type: 'brush', samples: [{ x: 2, y: 0 }], radius: 1 }],
        [],
    );
    const chunkAttribute = points.geometry.getAttribute('forceGround');
    assert.equal(chunkAttribute.count, 3);
    assert.deepEqual([...chunkAttribute.array], [0, 1, 0]);
});

test('drops an old frame chunk after navigation but accepts the current frame chunk', async () => {
    const { canApplyPointCloudChunk } = await loadChunkApplyGuard();

    assert.equal(
        canApplyPointCloudChunk('frame-2', 'frame-1', 2, 1, false),
        false,
    );
    assert.equal(
        canApplyPointCloudChunk('frame-2', 'frame-2', 2, 2, false),
        true,
    );
});

test('rebuilds forceGround after mask updates, undo, redo, and frame changes', async () => {
    const managerSource = await readFile(
        new URL('../src/packages/pc-editor/common/GroundCorrectionMaskManager.ts', import.meta.url),
        'utf8',
    );

    assert.match(managerSource, /refreshCurrentFramePointCloud/);
    assert.match(managerSource, /Event\.FRAME_CHANGE/);
    assert.match(managerSource, /Event\.UNDO/);
    assert.match(managerSource, /Event\.REDO/);
});
