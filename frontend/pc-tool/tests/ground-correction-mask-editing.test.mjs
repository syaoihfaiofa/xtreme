import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function readSource(relativePath) {
    return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

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
            'const THREE = { Group: class { constructor() { this.children = []; this.name = ""; } }, Object3D: class {}, Raycaster: class { constructor() { this.params = {}; } }, MathUtils: { generateUUID: () => "mask-id" } };',
        )
        .replace("import * as api from '../../../api';", 'const api = {};')
        .replace("import Editor from '../Editor';", 'class Editor {}')
        .replace(
            "import Event from '../config/event';",
            'const Event = { FRAME_CHANGE: "frame_change", UNDO: "undo", REDO: "redo" };',
        )
        .replace(
            /import \{[\s\S]*?\} from '\.\.\/type';/,
            'const ObjectType = { TYPE_GROUND_CORRECTION_MASK: "GROUND_CORRECTION_MASK" };',
        )
        .replace(
            "import OrbitControlsAction from '../../pc-render/action/OrbitControlsAction';",
            'class OrbitControlsAction {}',
        )
        .replace(
            "import { isAutomaticNonGround, isForceGround } from '../../pc-render/points/forceGround';",
            'const isAutomaticNonGround = () => true; const isForceGround = (value) => value > 0.5;',
        )
        .replace(
            "import { convertObject2Annotate } from '../utils/result';",
            'const convertObject2Annotate = () => [];',
        )
        .replace(
            /import \{[\s\S]*?\} from '\.\.\/utils\/groundCorrectionMaskEditing';/,
            'const appendGroundCorrectionMaskOperation = (mask, operation) => ({ version: 1, operations: [...mask.operations, operation] }); const formatGroundCorrectionMaskPropagationStatus = () => ""; const isGroundCorrectionMaskBevActive = (editor) => !!editor.viewManager.getMainView() && !editor.state.config.showSingleImgView; const planGroundCorrectionMaskPropagation = () => ({ frameIds: [], missingPoseFrameIds: [], differentSegmentFrameIds: [] }); const transformGroundCorrectionMaskOperation = (operation) => operation;',
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
        .replace("import GroundCorrectionPanel from './GroundCorrectionPanel.vue';", 'const GroundCorrectionPanel = {};')
        .replace("import { ILocale } from './lang/type';", '')
        .replace(
            "import { isGroundCorrectionMaskBevActive } from '../../packages/pc-editor/utils/groundCorrectionMaskEditing';",
            'const isGroundCorrectionMaskBevActive = (editor) => !!editor.viewManager.getMainView() && !editor.state.config.showSingleImgView;',
        );
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

test('treats the point-cloud main view as BEV without activeView state', async () => {
    const { isGroundCorrectionMaskBevActive } = await loadEditingModule();

    assert.equal(
        isGroundCorrectionMaskBevActive({
            state: { config: { showSingleImgView: false } },
            viewManager: { getMainView() { return {}; } },
        }),
        true,
    );
});

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
        heightRange: { min: -2, max: 1 },
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
            heightRange: { min: -2, max: 1 },
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

test('transforms persisted three-dimensional cluster points between location poses', async () => {
    const { transformGroundCorrectionMaskOperation } = await loadEditingModule();

    assert.deepEqual(
        transformGroundCorrectionMaskOperation(
            {
                type: 'cluster',
                points: [{ x: 1, y: 0, z: 2 }],
                radius: 0.3,
            },
            { dataId: 'source', posX: 10, posY: 0, posZ: 0, yaw: 0 },
            { dataId: 'target', posX: 11, posY: 0, posZ: 0, yaw: 0 },
        ),
        {
            type: 'cluster',
            points: [{ x: 0, y: 0, z: 2 }],
            radius: 0.3,
        },
    );
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
        state: { config: { showSingleImgView: true } },
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

test('manager toggles correction preview without changing orbit controls', async () => {
    const { default: GroundCorrectionMaskManager } = await loadGroundCorrectionMaskManager();
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    const uniforms = [];
    let planePointerDownListeners = 0;
    const editor = {
        state: {
            config: {
                showSingleImgView: false,
                groundCorrectionMode: false,
                groundCorrectionHeightRange: [-2, 1],
            },
        },
        pc: {
            scene: { add() {}, remove() {} },
            material: { setUniforms(value) { uniforms.push(value); } },
            ground: { plane: { constant: 0 } },
            render() {},
        },
        viewManager: {
            getMainView() {
                return {
                    renderer: {
                        domElement: {
                            addEventListener(type) {
                                if (type === 'pointerdown') planePointerDownListeners++;
                            },
                            removeEventListener() {},
                        },
                    },
                    getAction() {
                        return {
                        };
                    },
                };
            },
        },
        cmdManager: { addEventListener() {}, removeEventListener() {} },
        addEventListener() {},
        removeEventListener() {},
        showMsg() {},
    };
    const manager = new GroundCorrectionMaskManager(editor);

    manager.activate();
    assert.equal(editor.state.config.groundCorrectionMode, true);
    assert.equal(planePointerDownListeners, 1);
    assert.deepEqual(uniforms.at(-1), { groundCorrectionPreview: 1 });

    manager.deactivate();
    assert.equal(editor.state.config.groundCorrectionMode, false);
    assert.deepEqual(uniforms.at(-1), { groundCorrectionPreview: -1 });
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
            state: { config: { showSingleImgView: true } },
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

test('toolbar hides the ground correction mode entry outside the BEV main view', async () => {
    const { allItems } = await loadToolItems();
    const editor = {
        activeView: {},
        state: {
            config: { showSingleImgView: true },
            modeConfig: { actions: { deleteObject: true } },
        },
        viewManager: { getMainView() { return {}; } },
    };
    const actions = new Set(['groundCorrectionMode']);
    const entries = allItems.filter((item) => actions.has(item.action));

    assert.equal(entries.length, 1);
    assert.ok(entries.every((item) => item.isDisplay(editor) === false));
});

test('renders the correction controls as a sibling rail beside the main toolbar', async () => {
    const toolSource = await readSource('../src/components/Tool/index.vue');
    const correctionSource = await readSource('../src/components/Tool/GroundCorrectionPanel.vue');

    assert.match(toolSource, /import GroundCorrectionPanel from '\.\/GroundCorrectionPanel\.vue';/);
    assert.match(
        toolSource,
        /<\/template>\s*<GroundCorrectionPanel \/>\s*<div\s+v-show="editor\.state\.status/,
    );
    assert.match(correctionSource, /class="ground-correction-panel"/);
    assert.match(correctionSource, /class="item"/);
    assert.match(correctionSource, /<a-input-number/);
    assert.match(correctionSource, /@update:value="updateHeight\(0, \$event\)"/);
    assert.match(correctionSource, /@update:value="updateHeight\(1, \$event\)"/);
    assert.doesNotMatch(correctionSource, /function editHeight/);
});

test('restores the complete camera state after leaving correction mode', async () => {
    const orbitSource = await readSource(
        '../src/packages/pc-render/action/OrbitControlsAction.ts',
    );

    assert.match(orbitSource, /private cameraStateBeforeLock/);
    assert.match(orbitSource, /renderView\.camera\.position\.copy\(this\.cameraStateBeforeLock\.position\)/);
    assert.match(orbitSource, /renderView\.camera\.up\.copy\(this\.cameraStateBeforeLock\.up\)/);
    assert.match(orbitSource, /control\.target\.copy\(this\.cameraStateBeforeLock\.target\)/);
    assert.doesNotMatch(orbitSource, /camera\.up\.set\(0,\s*1,\s*0\)/);
});

test('leaves Ctrl plus left drag to the default orbit controls', async () => {
    const managerSource = await readSource(
        '../src/packages/pc-editor/common/GroundCorrectionMaskManager.ts',
    );

    assert.match(managerSource, /if \(event\.button === 0 && event\.ctrlKey\) return;/);
    assert.doesNotMatch(managerSource, /lockTopDown\(\)/);
    assert.doesNotMatch(managerSource, /unlockRotation\(\)/);
});

test('keeps polygon editing active and previews the unfinished polygon', async () => {
    const managerSource = await readSource(
        '../src/packages/pc-editor/common/GroundCorrectionMaskManager.ts',
    );

    assert.match(managerSource, /this\.previewPolygon\(\);/);
    assert.match(managerSource, /private previewPolygon\(\): void/);
    assert.match(managerSource, /if \(this\.mode === 'polygon' \|\| this\.mode === 'cluster' \|\| this\.mode === 'eraser'\) \{\s*this\.points = \[\];\s*this\.renderOverlay\(\);\s*return;/);
    assert.match(managerSource, /this\.mode === 'eraser' \? \{ erase: true as const \} : \{\}/);
    assert.match(managerSource, /event\.key === 'Escape' && this\.mode === 'polygon' && this\.points\.length > 0/);
    assert.match(managerSource, /event\.key === 'Escape' && this\.mode\) \{[\s\S]*?this\.editor\.actionManager\.stopCurrentAction\(\);/);
    assert.match(managerSource, /\(event\.ctrlKey \|\| event\.metaKey\) && event\.key\.toLowerCase\(\) === 'z'/);
    assert.match(managerSource, /this\.editor\.cmdManager\.undo\(\);/);
    assert.match(managerSource, /this\.editor\.cmdManager\.redo\(\);/);
});

test('renders a visible marker for every ground correction polygon vertex', async () => {
    const managerSource = await readSource(
        '../src/packages/pc-editor/common/GroundCorrectionMaskManager.ts',
    );

    assert.match(managerSource, /new THREE\.Points\(/);
    assert.match(managerSource, /new THREE\.PointsMaterial\(\s*\{\s*color: 0xffd700,\s*size: 3/);
});

test('picks cluster seeds near the configured absolute pick plane and reuses its spatial index', async () => {
    const managerSource = await readSource(
        '../src/packages/pc-editor/common/GroundCorrectionMaskManager.ts',
    );
    const stateSource = await readSource('../src/packages/pc-editor/state.ts');
    const panelSource = await readSource('../src/components/Tool/GroundCorrectionPanel.vue');

    assert.match(stateSource, /groundCorrectionPickZ: -0\.332/);
    assert.match(panelSource, /groundCorrectionPickZ/);
    assert.match(managerSource, /new THREE\.Plane\(new THREE\.Vector3\(0, 0, 1\), -pickZ\)/);
    assert.match(managerSource, /findSeedNearPlanePoint/);
    assert.doesNotMatch(managerSource, /ground\.plane\.constant/);
    assert.match(managerSource, /private clusterIndex\?: ClusterSpatialIndex/);
    assert.match(managerSource, /private clusterIndexKey\?: string/);
    assert.match(managerSource, /geometry\?\.uuid/);
    assert.match(managerSource, /position\?\.version/);
    assert.match(managerSource, /this\.clusterCandidate = seed/);
    assert.match(managerSource, /拾取平面 Z=/);
    assert.match(stateSource, /groundCorrectionClusterHeightTolerance: 0\.2/);
    assert.match(panelSource, /groundCorrectionClusterHeightTolerance/);
    assert.match(managerSource, /pickZ - tolerance/);
    assert.match(managerSource, /!isAutomaticNonGround\(\{/);
    assert.match(managerSource, /!isForceGround\(forceGround\.getX\(source\.index\)\)/);
    assert.match(managerSource, /collectConnected\(seedIndex, radius, heightRange, isSelectable\)/);
    assert.match(managerSource, /Math\.abs\(dz\) > maxDz/);
    assert.match(managerSource, /heightRange: \{ min: BELOW_GROUND_MIN_Z, max: maxZ \}/);
    assert.match(panelSource, /editor\.groundCorrectionMaskManager\.applyBelowGround\(\)/);
    assert.match(panelSource, /editor\.actionManager\.stopCurrentAction\(\);\s*void editor\.actionManager\.execute\(name\);/);
    const actionManagerSource = await readSource('../src/packages/pc-editor/common/ActionManager/index.ts');
    assert.match(actionManagerSource, /if \(this\.currentRunId === runId && this\.currentAction === action\)/);
    assert.match(actionManagerSource, /this\.currentRunId\+\+;\s*action\.end\(this\.editor\);/);
    assert.match(managerSource, /cluster-candidate-marker/);
});

test('keeps cluster mode active after saving a cluster operation', async () => {
    const managerSource = await readSource(
        '../src/packages/pc-editor/common/GroundCorrectionMaskManager.ts',
    );

    assert.match(managerSource, /this\.mode === 'polygon' \|\| this\.mode === 'cluster'/);
});

test('previews force-ground points in gray only when they were automatic non-ground', async () => {
    const materialSource = await readSource(
        '../src/packages/pc-render/material/PointsMaterial.ts',
    );

    assert.match(
        materialSource,
        /groundCorrectionPreview > 0\.0[\s\S]*forceGround > \$\{FORCE_GROUND_THRESHOLD\}[\s\S]*abs\(color\.r - intensity\)/,
    );
    assert.match(materialSource, /vColor = vec3\(0\.5\);/);
});

test('exposes point-cloud cluster selection with a configurable radius', async () => {
    const managerSource = await readSource(
        '../src/packages/pc-editor/common/GroundCorrectionMaskManager.ts',
    );
    const panelSource = await readSource('../src/components/Tool/GroundCorrectionPanel.vue');

    assert.match(managerSource, /class ClusterSpatialIndex/);
    assert.match(managerSource, /collectConnected\(/);
    assert.match(managerSource, /MAX_CLUSTER_POINTS = 10_000/);
    assert.match(managerSource, /this\.raycaster\.ray\.intersectPlane\(/);
    assert.match(panelSource, /groundCorrectionClusterRadius/);
    assert.match(panelSource, /editGroundCorrectionCluster/);
});
