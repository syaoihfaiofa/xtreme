import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadClassHelper() {
    const sourcePath = new URL('../src/components/Instance/useClassItem.ts', import.meta.url);
    const source = await readFile(sourcePath, 'utf8');
    const match = source.match(/export function getObjectsForClass[\s\S]*?\n}/);
    if (!match) throw new Error('getObjectsForClass implementation not found');
    const functionSource = match[0]
        .replace('export ', '')
        .replace(/item: Pick<IClass, 'classId' \| 'classType'>/, 'item')
        .replace(/objects: AnnotateObject\[\]/, 'objects')
        .replace(/\): AnnotateObject\[\]/, ')')
        .replace(/ as IUserData/g, '');
    return new Function(`${functionSource}; return { getObjectsForClass };`)();
}

test('getObjectsForClass selects Polygon objects across frames by class', async () => {
    const { getObjectsForClass } = await loadClassHelper();
    const item = { classId: 'pillar-class', classType: 'pillar' };
    const objects = [
        { uuid: 'pillar-current', userData: { classId: 'pillar-class', classType: 'pillar' } },
        { uuid: 'pillar-other-frame', userData: { classId: 'pillar-class', classType: 'pillar' } },
        { uuid: 'box-other-frame', userData: { classId: 'box-class', classType: 'box' } },
    ];

    assert.deepEqual(getObjectsForClass(item, objects), [objects[0], objects[1]]);
});
