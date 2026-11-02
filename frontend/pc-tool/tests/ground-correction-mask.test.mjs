import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadGroundCorrectionMask() {
    const sourcePath = new URL(
        '../src/packages/pc-editor/utils/groundCorrectionMask.ts',
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

async function readSource(relativePath) {
    return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

test('serializes and restores ordered polygon and brush mask operations', async () => {
    const {
        deserializeGroundCorrectionMask,
        serializeGroundCorrectionMask,
    } = await loadGroundCorrectionMask();
    const payload = {
        version: 1,
        operations: [
            {
                type: 'polygon',
                vertices: [
                    { x: 1, y: 2 },
                    { x: 3, y: 4 },
                    { x: 5, y: 6 },
                ],
                heightRange: { min: -2, max: 1 },
            },
            {
                type: 'brush',
                center: { x: 7, y: 8 },
                radius: 2.5,
                heightRange: { min: -1, max: 3 },
            },
        ],
    };

    const serialized = serializeGroundCorrectionMask(payload);

    assert.deepEqual(serialized, payload);
    assert.deepEqual(deserializeGroundCorrectionMask(serialized), payload);
});

test('keeps operation origins through serialization and rejects unknown origins', async () => {
    const { deserializeGroundCorrectionMask, serializeGroundCorrectionMask } = await loadGroundCorrectionMask();
    const payload = {
        version: 1,
        operations: [
            { type: 'polygon', vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], origin: 'propagated' },
            { type: 'brush', samples: [{ x: 1, y: 1 }], radius: 0.35, heightRange: { min: -1, max: 0 }, origin: 'transfer' },
            { type: 'cluster', points: [{ x: 1, y: 1, z: 0 }], radius: 0.3, origin: 'propagated' },
        ],
    };

    assert.deepEqual(deserializeGroundCorrectionMask(serializeGroundCorrectionMask(payload)), payload);
    assert.throws(
        () => deserializeGroundCorrectionMask({ version: 1, operations: [{ ...payload.operations[1], origin: 'other' }] }),
        /payload is invalid/,
    );
});

test('rejects invalid ground correction mask payloads', async () => {
    const { deserializeGroundCorrectionMask } = await loadGroundCorrectionMask();

    assert.throws(
        () => deserializeGroundCorrectionMask({ version: 1, operations: [{ type: 'brush' }] }),
        /GROUND_CORRECTION_MASK/,
    );
});

test('round-trips a mask through classAttributes.meta', async () => {
    const {
        deserializeGroundCorrectionMaskMeta,
        serializeGroundCorrectionMaskMeta,
    } = await loadGroundCorrectionMask();
    const payload = {
        version: 1,
        operations: [
            {
                type: 'brush',
                center: { x: 1, y: 2 },
                radius: 3,
            },
        ],
    };
    const classAttributes = {
        meta: serializeGroundCorrectionMaskMeta(payload),
    };

    assert.deepEqual(deserializeGroundCorrectionMaskMeta(classAttributes.meta), payload);
});

test('serializes bounded three-dimensional cluster point sets', async () => {
    const {
        deserializeGroundCorrectionMask,
        serializeGroundCorrectionMask,
    } = await loadGroundCorrectionMask();
    const payload = {
        version: 1,
        operations: [{
            type: 'cluster',
            points: [{ x: 1, y: 2, z: 3 }, { x: 1.1, y: 2, z: 3 }],
            radius: 0.3,
        }],
    };

    const serialized = serializeGroundCorrectionMask(payload);
    assert.deepEqual(serialized, payload);
    assert.notEqual(serialized.operations[0].points, payload.operations[0].points);
    assert.throws(
        () => deserializeGroundCorrectionMask({
            version: 1,
            operations: [{
                type: 'cluster',
                points: Array.from({ length: 10_001 }, () => ({ x: 0, y: 0, z: 0 })),
                radius: 0.3,
            }],
        }),
        /GROUND_CORRECTION_MASK/,
    );
});

test('reports invalid mask payloads without mutating the source object', async () => {
    const { restoreGroundCorrectionMask } = await loadGroundCorrectionMask();
    const sourceObject = {
        id: 'mask-17',
        groundCorrectionMask: { version: 1, operations: [{ type: 'brush' }] },
    };
    const original = JSON.parse(JSON.stringify(sourceObject));

    const result = restoreGroundCorrectionMask(sourceObject.groundCorrectionMask, sourceObject.id);

    assert.equal(result.mask, undefined);
    assert.match(result.warning, /mask-17/);
    assert.match(result.warning, /payload is invalid/);
    assert.deepEqual(sourceObject, original);
});

test('keeps loaded masks hidden and excludes them before merged track discovery', async () => {
    const resultSource = await readSource('../src/packages/pc-editor/utils/result.ts');
    const loadManagerSource = await readSource('../src/packages/pc-editor/common/LoadManager.ts');

    assert.match(resultSource, /object\.visible = false/);
    assert.match(resultSource, /console\.warn\(restoration\.warning\)/);
    assert.match(
        loadManagerSource,
        /const trackObjectsMap: Record<string, IObject\[]> = \{\};[\s\S]*?getTrackFromObject\(trackObjectsMap\)/,
    );
    assert.match(
        loadManagerSource,
        /mergeTrackData[\s\S]*?const trackObjectsMap: Record<string, IObject\[]> = \{\};[\s\S]*?getTrackFromObject\(trackObjectsMap\)/,
    );
});
