import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadEditingModule() {
    const sourcePath = new URL(
        '../src/packages/pc-editor/utils/groundCorrectionMaskEditing.ts',
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

async function loadGroundCorrectionMaskCommand() {
    const sourcePath = new URL(
        '../src/packages/pc-editor/common/CmdManager/cmd/UpdateGroundCorrectionMask.ts',
        import.meta.url,
    );
    const source = (await readFile(sourcePath, 'utf8')).replace(
        "import CmdBase from '../CmdBase';",
        'class CmdBase { constructor(editor, data) { this.editor = editor; this.data = data; this.undoData = null; } canMerge() { return false; } }',
    );
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

async function loadGroundCorrectionMaskManager() {
    const sourcePath = new URL(
        '../src/packages/pc-editor/common/GroundCorrectionMaskManager.ts',
        import.meta.url,
    );
    let source = await readFile(sourcePath, 'utf8');
    source = source
        .replace(
            "import * as THREE from 'three';",
            'const THREE = { Group: class { constructor() { this.children = []; this.name = ""; } }, Object3D: class {}, MathUtils: { generateUUID: () => "mask-id" } };',
        )
        .replace("import * as api from '../../../api';", 'const api = {};')
        .replace("import Editor from '../Editor';", 'class Editor {}')
        .replace(
            "import Event from '../config/event';",
            'const Event = { FRAME_CHANGE: "frame_change", UNDO: "undo", REDO: "redo" };',
        )
        .replace(
            "import { ObjectType, type GroundCorrectionMask, type GroundCorrectionMaskOperation } from '../type';",
            'const ObjectType = { TYPE_GROUND_CORRECTION_MASK: "GROUND_CORRECTION_MASK" };',
        )
        .replace(
            "import { convertObject2Annotate } from '../utils/result';",
            'const convertObject2Annotate = () => [];',
        )
        .replace(
            /import \{[\s\S]*?\} from '\.\.\/utils\/groundCorrectionMaskEditing';/,
            'const appendGroundCorrectionMaskOperation = (mask, operation) => ({ version: 1, operations: [...mask.operations, operation] }); const formatGroundCorrectionMaskPropagationStatus = () => ""; const isGroundCorrectionMaskBevActive = (editor) => !!editor.viewManager.getMainView() && editor.activeView === editor.viewManager.getMainView() && !editor.state.config.showSingleImgView; const planGroundCorrectionMaskPropagation = () => ({ frameIds: [], missingPoseFrameIds: [], differentSegmentFrameIds: [] }); const transformGroundCorrectionMaskOperation = (operation) => operation;',
        );
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

async function loadToolItems() {
    const sourcePath = new URL('../src/components/Tool/item.ts', import.meta.url);
    let source = await readFile(sourcePath, 'utf8');
    source = source
        .replace("import { IState } from 'pc-editor';", '')
        .replace("import Editor from '../../common/Editor';", '')
        .replace("import { BsUIType as UIType } from '../../config/ui';", 'const UIType = {};')
        .replace("import { Component } from 'vue';", '')
        .replace("import ToolTip from './modelConfig.vue';", 'const ToolTip = {};')
        .replace("import SetBox from './setBox.vue';", 'const SetBox = {};')
        .replace("import SetHelper2D from './setHelper2D.vue';", 'const SetHelper2D = {};')
        .replace("import { ILocale } from './lang/type';", '')
        .replace(
            "import { isGroundCorrectionMaskBevActive } from '../../packages/pc-editor/utils/groundCorrectionMaskEditing';",
            'const isGroundCorrectionMaskBevActive = (editor) => !!editor.viewManager.getMainView() && editor.activeView === editor.viewManager.getMainView() && !editor.state.config.showSingleImgView;',
        );
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

test('applies each completed brush stroke as one immutable operation', async () => {
    const { appendGroundCorrectionMaskOperation } = await loadEditingModule();
    const initial = { version: 1, operations: [] };
    const operation = {
        type: 'brush',
        samples: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
        radius: 0.5,
    };

    const next = appendGroundCorrectionMaskOperation(initial, operation);

    assert.deepEqual(next, { version: 1, operations: [operation] });
    assert.deepEqual(initial, { version: 1, operations: [] });
    assert.notEqual(next.operations[0], operation);
});

test('maps polygon vertices and brush samples using target inverse times source pose', async () => {
    const { transformGroundCorrectionMaskOperation } = await loadEditingModule();
    const sourcePose = { dataId: 'source', posX: 10, posY: 0, posZ: 0, yaw: Math.PI / 2 };
    const targetPose = { dataId: 'target', posX: 10, posY: 10, posZ: 0, yaw: Math.PI / 2 };
    const polygon = {
        type: 'polygon',
        vertices: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }],
    };
    const brush = {
        type: 'brush',
        samples: [{ x: 1, y: 0 }, { x: 0, y: 1 }],
        radius: 2,
    };

    assert.deepEqual(
        transformGroundCorrectionMaskOperation(polygon, sourcePose, targetPose),
        {
            type: 'polygon',
            vertices: [{ x: -9, y: 0 }, { x: -10, y: 1 }, { x: -11, y: 0 }],
        },
    );
    assert.deepEqual(
        transformGroundCorrectionMaskOperation(brush, sourcePose, targetPose),
        {
            type: 'brush',
            samples: [{ x: -9, y: 0 }, { x: -10, y: 1 }],
            radius: 2,
        },
    );
});

test('uses the same XYZ pose rotation convention as location rendering', async () => {
    const { transformGroundCorrectionMaskOperation } = await loadEditingModule();
    const operation = {
        type: 'brush',
        samples: [{ x: 1, y: 0 }],
        radius: 1,
    };

    const transformed = transformGroundCorrectionMaskOperation(
        operation,
        { dataId: 'source', posX: 0, posY: 0, posZ: 0, yaw: 0, pitch: Math.PI / 2 },
        { dataId: 'target', posX: 0, posY: 0, posZ: 0, yaw: 0 },
    );
    const sample = transformed.samples?.[0];

    assert.ok(sample);
    assert.ok(Math.abs(sample.x) < 1e-10);
    assert.ok(Math.abs(sample.y) < 1e-10);
});

test('only selects contiguous neighboring frames with available locations', async () => {
    const { planGroundCorrectionMaskPropagation } = await loadEditingModule();
    const frames = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
    const poses = {
        a: { dataId: 'a', posX: 0, posY: 0, posZ: 0, yaw: 0 },
        b: { dataId: 'b', posX: 0, posY: 0, posZ: 0, yaw: 0 },
        c: { dataId: 'c', posX: 0, posY: 0, posZ: 0, yaw: 0 },
        e: { dataId: 'e', posX: 0, posY: 0, posZ: 0, yaw: 0 },
    };

    assert.deepEqual(planGroundCorrectionMaskPropagation(frames, 2, 2, poses, {
        a: 'scene-1:0',
        b: 'scene-1:0',
        c: 'scene-1:0',
        e: 'scene-1:1',
    }), {
        frameIds: ['a', 'b'],
        missingPoseFrameIds: ['d'],
        differentSegmentFrameIds: ['e'],
    });
});

test('uses the server location segment map within the requested N window', async () => {
    const { planGroundCorrectionMaskPropagation } = await loadEditingModule();
    const frames = [
        { id: 'a', name: 'misleading_0_0' },
        { id: 'b', name: 'misleading_0_500000000' },
        { id: 'c', name: 'misleading_1_0' },
        { id: 'd', name: 'misleading_1_1' },
        { id: 'e', name: 'misleading_1_2' },
        { id: 'f', name: 'misleading_1_3' },
    ];
    const poses = Object.fromEntries(
        frames.map((frame) => [
            frame.id,
            { dataId: frame.id, posX: 0, posY: 0, posZ: 0, yaw: 0 },
        ]),
    );

    assert.deepEqual(planGroundCorrectionMaskPropagation(frames, 2, 2, poses, {
        a: 'scene-1:7',
        b: 'scene-1:7',
        c: 'scene-1:7',
        d: 'scene-1:8',
        e: 'scene-1:8',
        f: 'scene-1:8',
    }), {
        frameIds: ['a', 'b'],
        missingPoseFrameIds: [],
        differentSegmentFrameIds: ['d', 'e'],
    });
});

test('preserves a pending mask when a full frame reload replaces cached objects', async () => {
    const { mergePendingGroundCorrectionMask } = await loadEditingModule();
    const serverMask = {
        id: 'server-mask',
        objectType: 'GROUND_CORRECTION_MASK',
        userData: { groundCorrectionMask: { version: 1, operations: [{ type: 'polygon', vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }] } },
    };
    const pendingMask = {
        id: 'server-mask',
        objectType: 'GROUND_CORRECTION_MASK',
        userData: { groundCorrectionMask: { version: 1, operations: [{ type: 'brush', samples: [{ x: 2, y: 3 }], radius: 1 }] } },
    };
    const loaded = [{ id: 'box', objectType: '3D_BOX', userData: {} }, serverMask];

    const merged = mergePendingGroundCorrectionMask(loaded, pendingMask);

    assert.deepEqual(merged, [loaded[0], pendingMask]);
    assert.equal(merged.filter((object) => object.objectType === 'GROUND_CORRECTION_MASK').length, 1);
});

test('reports missing poses, location discontinuities, and load failures separately', async () => {
    const { formatGroundCorrectionMaskPropagationStatus } = await loadEditingModule();

    const message = formatGroundCorrectionMaskPropagationStatus(
        2,
        {
            frameIds: ['a', 'b'],
            missingPoseFrameIds: ['c'],
            differentSegmentFrameIds: ['d', 'e'],
        },
        3,
    );

    assert.match(message, /缺少 location 位姿 1 帧/);
    assert.match(message, /不同 location segment 2 帧/);
    assert.match(message, /加载失败 3 帧/);
});

test('keeps consecutive mask commits as independently undoable commands', async () => {
    const { default: UpdateGroundCorrectionMask } = await loadGroundCorrectionMaskCommand();
    const object = { userData: { groundCorrectionMask: { version: 1, operations: [] } } };
    const editor = {
        dataManager: {
            setAnnotatesUserData(target, data) {
                Object.assign(target.userData, data);
            },
        },
    };
    const frame = { id: 'frame-1' };
    const first = new UpdateGroundCorrectionMask(editor, {
        object,
        frame,
        mask: {
            version: 1,
            operations: [{ type: 'brush', samples: [{ x: 1, y: 1 }], radius: 1 }],
        },
    });
    const second = new UpdateGroundCorrectionMask(editor, {
        object,
        frame,
        mask: {
            version: 1,
            operations: [
                { type: 'brush', samples: [{ x: 1, y: 1 }], radius: 1 },
                { type: 'brush', samples: [{ x: 2, y: 2 }], radius: 1 },
            ],
        },
    });

    first.redo();
    second.redo();
    second.undo();
    assert.equal(object.userData.groundCorrectionMask.operations.length, 1);
    first.undo();
    assert.equal(object.userData.groundCorrectionMask.operations.length, 0);
    assert.equal(first.canMerge(second), false);
});

test('manager delegates an existing mask commit to the dedicated command', async () => {
    const { default: GroundCorrectionMaskManager } = await loadGroundCorrectionMaskManager();
    const calls = [];
    const maskObject = {
        objectType: 'GROUND_CORRECTION_MASK',
        userData: { groundCorrectionMask: { version: 1, operations: [] } },
    };
    globalThis.window = { removeEventListener() {} };
    const editor = {
        pc: { scene: { add() {}, remove() {} }, render() {} },
        viewManager: { getMainView() { return undefined; } },
        getCurrentFrame() { return { id: 'frame-1' }; },
        dataManager: {
            getFrameObject() { return [maskObject]; },
        },
        cmdManager: {
            execute(name, data) {
                calls.push({ name, data });
            },
        },
        showMsg() {},
    };
    const manager = new GroundCorrectionMaskManager(editor);

    manager.commit({ type: 'brush', samples: [{ x: 1, y: 2 }], radius: 1 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'update-ground-correction-mask');
    assert.equal(calls[0].data.object, maskObject);
});

test('manager disables delete and propagation outside the BEV main view', async () => {
    const { default: GroundCorrectionMaskManager } = await loadGroundCorrectionMaskManager();
    const calls = [];
    const messages = [];
    const mainView = {};
    const editor = {
        activeView: {},
        state: { config: { showSingleImgView: false } },
        pc: { scene: { add() {}, remove() {} }, render() {} },
        viewManager: { getMainView() { return mainView; } },
        cmdManager: { execute(...args) { calls.push(args); } },
        showMsg(...args) { messages.push(args); },
    };
    const manager = new GroundCorrectionMaskManager(editor);

    await manager.start('polygon');
    await manager.start('brush');
    manager.deleteLastOperation();
    await manager.propagate(1);

    assert.equal(calls.length, 0);
    assert.equal(messages.length, 4);
    assert.ok(messages.every(([, message]) => /BEV 主视图/.test(message)));
});

test('propagation request does not open an input outside the BEV main view', async () => {
    const {
        requestGroundCorrectionMaskPropagation,
    } = await loadEditingModule();
    let promptCount = 0;
    const messages = [];
    requestGroundCorrectionMaskPropagation(
        {
            activeView: {},
            state: { config: { showSingleImgView: false } },
            viewManager: { getMainView() { return {}; } },
            showMsg(...args) { messages.push(args); },
            groundCorrectionMaskManager: { async propagate() {} },
        },
        () => {
            promptCount++;
            return '1';
        },
    );

    assert.equal(promptCount, 0);
    assert.match(messages[0][1], /BEV 主视图/);
});

test('toolbar hides all ground correction entries outside the BEV main view', async () => {
    const { allItems } = await loadToolItems();
    const editor = {
        activeView: {},
        state: {
            config: { showSingleImgView: false },
            modeConfig: { actions: { deleteObject: true } },
        },
        viewManager: { getMainView() { return {}; } },
    };
    const actions = new Set([
        'groundCorrectionPolygon',
        'groundCorrectionBrush',
        'deleteGroundCorrectionOperation',
        'propagateGroundCorrectionMask',
    ]);
    const entries = allItems.filter((item) => actions.has(item.action));

    assert.equal(entries.length, 4);
    assert.ok(entries.every((item) => item.isDisplay(editor) === false));
});
