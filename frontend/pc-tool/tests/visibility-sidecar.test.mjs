import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadHelper() {
    const sourcePath = new URL('../src/api/visibilitySidecar.ts', import.meta.url);
    const source = await readFile(sourcePath, 'utf8');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

test('strips only exact visibility sidecar fields', async () => {
    const { stripAutoVisibilitySidecarFields } = await loadHelper();
    const attributes = {
        autoVisibleRatio: 0.4,
        autoVisibleRatioByView: { bev: 0.4 },
        autoOccluded: true,
        autoSegmentVisibilityByView: { bev: [] },
        autoSegmentMeta: { numSegments: 2 },
        autoCurbOcclusionPending: true,
        autoCustomField: 'preserve',
        label: 'car',
    };

    assert.deepEqual(stripAutoVisibilitySidecarFields(attributes), {
        autoCurbOcclusionPending: true,
        autoCustomField: 'preserve',
        label: 'car',
    });
});
