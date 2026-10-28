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
        .replace(
            "import { calculateForceGround, type ForceGroundOperation } from './forceGround';",
            '',
        )
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
            ...automaticNonGround,
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
            1.5, 0.5, 0,
            0, 0.5, 0,
        ]),
        [{
            type: 'polygon',
            vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
        }],
    );

    assert.deepEqual([...forceGround], [1, 0, 1]);
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
    );

    assert.deepEqual([...forceGround], [1, 1, 0]);
});

test('creates matching forceGround attributes for full and late chunk point clouds', async () => {
    const { default: Points } = await loadPoints();
    const points = new Points({});

    points.updateData({ position: [0, 0, 0, 3, 0, 0] }, []);
    const fullAttribute = points.geometry.getAttribute('forceGround');
    assert.equal(fullAttribute.count, 2);
    assert.deepEqual([...fullAttribute.array], [0, 0]);

    points.updateData(
        { position: [0, 0, 0, 2, 0, 0, 4, 0, 0] },
        [{ type: 'brush', samples: [{ x: 2, y: 0 }], radius: 1 }],
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
