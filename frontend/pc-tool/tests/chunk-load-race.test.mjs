import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

function createDeferred() {
    let resolve;
    const promise = new Promise((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

async function loadDataResource() {
    const sourcePath = new URL(
        '../src/packages/pc-editor/common/DataResource.ts',
        import.meta.url,
    );
    let source = await readFile(sourcePath, 'utf8');
    source = source
        .replace("import { IDataResource, IFrame, IFileConfig, PointAttr } from '../type';", '')
        .replace("import { PCDLoader } from 'pc-render';", 'class PCDLoader {}')
        .replace("import Editor from '../Editor';", 'class Editor {}')
        .replace("import * as utils from '../utils';", 'const utils = {};')
        .replace("import Event from '../config/event';", 'const Event = { RESOURCE_LOAD_COMPLETE: "complete" };')
        .replace("import { IImgViewConfig } from 'pc-editor';", '')
        .replace("import { orderEvictionCandidates, orderPrefetchIndices } from './CachePolicy';", 'const orderEvictionCandidates = () => []; const orderPrefetchIndices = () => [];')
        .replace("import { canApplyPointCloudChunk } from './chunkApplyGuard';", 'const canApplyPointCloudChunk = (currentFrameId, requestFrameId, currentGeneration, requestGeneration, isAborted) => !isAborted && currentFrameId === requestFrameId && currentGeneration === requestGeneration;')
        .replace("import { shouldScheduleFullLoad } from './FullLoadPolicy';", 'const shouldScheduleFullLoad = () => true;');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

async function flushAsyncWork() {
    await new Promise((resolve) => setImmediate(resolve));
}

test('aborts old-frame manifest and chunk work without applying stale point data', async () => {
    const { default: DataResource } = await loadDataResource();
    const manifest = createDeferred();
    const chunk = createDeferred();
    const chunkSignals = [];
    const calls = { chunks: [], data: [] };
    const frames = [{ id: 'old', needSave: true }, { id: 'current' }];
    const editor = {
        state: { frames, frameIndex: 0, config: {} },
        getCurrentFrame() { return frames[this.state.frameIndex]; },
        playManager: { playing: false },
        performanceMonitor: { start() {}, end() {}, record() {} },
        dispatchEvent() {},
        pc: {
            addEventListener() {},
            getVisibleChunkIds() { return ['chunk-1']; },
            selection: [],
            removePointCloudChunk() {},
            setPointCloudChunk(...args) { calls.chunks.push(args); },
            setPointCloudData(...args) { calls.data.push(args); },
        },
    };
    const resource = new DataResource(editor);
    resource.getChunkManifest = () => manifest.promise;
    resource.loadPoints = (_url, _progress, signal) => {
        chunkSignals.push(signal);
        return chunk.promise;
    };
    const parentController = new AbortController();
    const pending = resource.upgradeToFull(
        frames[0],
        { chunkManifestUrl: 'https://example.test/manifest.json', resourceState: 'preview-ready' },
        resource.generation,
        parentController,
    );

    manifest.resolve({
        chunks: [{ id: 'chunk-1', url: 'https://example.test/chunk.pcd', byteSize: 3 }],
    });
    await flushAsyncWork();
    assert.equal(chunkSignals.length, 1);

    editor.state.frameIndex = 1;
    resource.activateFrame(frames[1]);
    assert.equal(parentController.signal.aborted, true);
    assert.ok(chunkSignals.every((signal) => signal.aborted));

    chunk.resolve({ position: [0, 0, 0] });
    await pending;
    assert.deepEqual(calls.chunks, []);
    assert.deepEqual(calls.data, []);
});

test('applies a current-frame chunk after its manifest and data resolve', async () => {
    const { default: DataResource } = await loadDataResource();
    const calls = [];
    const frame = { id: 'current' };
    const editor = {
        state: { frames: [frame], frameIndex: 0, config: {} },
        getCurrentFrame() { return frame; },
        playManager: { playing: false },
        performanceMonitor: { start() {}, end() {}, record() {} },
        dispatchEvent() {},
        pc: {
            addEventListener() {},
            getVisibleChunkIds() { return ['chunk-1']; },
            selection: [],
            removePointCloudChunk() {},
            setPointCloudChunk(...args) { calls.push(args); },
        },
    };
    const resource = new DataResource(editor);
    resource.getChunkManifest = async () => ({
        chunks: [{ id: 'chunk-1', url: 'https://example.test/chunk.pcd', byteSize: 3 }],
    });
    resource.loadPoints = async () => ({ position: [0, 0, 0, 2, 0, 0] });

    await resource.upgradeToFull(
        frame,
        { chunkManifestUrl: 'https://example.test/manifest.json', resourceState: 'preview-ready' },
        resource.generation,
        new AbortController(),
    );

    assert.deepEqual(calls, [['chunk-1', { position: [0, 0, 0, 2, 0, 0] }]]);
});
