import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadHelper() {
    const sourcePath = new URL('../src/packages/pc-editor/utils/modelClassMapping.ts', import.meta.url);
    const source = await readFile(sourcePath, 'utf8');
    const match = source.match(/export function compactClassKey[\s\S]*?\n}/);
    if (!match) throw new Error('compactClassKey implementation not found');
    const functionSource = match[0]
        .replace('export ', '')
        .replace(/name: string \| number/, 'name')
        .replace(/\): string/, ')');
    return new Function(`${functionSource}; return { compactClassKey };`)();
}

test('compactClassKey accepts a numeric stale class ID', async () => {
    const { compactClassKey } = await loadHelper();

    assert.equal(compactClassKey(20), '20');
});
