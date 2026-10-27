import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadHelper() {
    const sourcePath = new URL('../src/components/Instance/visibilityFilter.ts', import.meta.url);
    const source = await readFile(sourcePath, 'utf8');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

test('combines global and current-frame hidden types without duplicates', async () => {
    const { getHiddenInstanceTypes } = await loadHelper();
    const state = {
        allFrames: ['3d-box', 'polygon'],
        frames: { 'frame-1': ['polygon', 'polyline'] },
    };

    assert.deepEqual(getHiddenInstanceTypes(state, 'frame-1'), ['3d-box', 'polygon', 'polyline']);
});

test('updates only the requested visibility scope', async () => {
    const { setInstanceTypeHidden } = await loadHelper();
    const state = {
        allFrames: ['3d-box'],
        frames: { 'frame-1': ['polygon'] },
    };

    const next = setInstanceTypeHidden(state, 'current-frame', 'frame-1', 'polyline', true);

    assert.deepEqual(next.allFrames, ['3d-box']);
    assert.deepEqual(next.frames, { 'frame-1': ['polygon', 'polyline'] });
    assert.deepEqual(state.frames, { 'frame-1': ['polygon'] });
});
