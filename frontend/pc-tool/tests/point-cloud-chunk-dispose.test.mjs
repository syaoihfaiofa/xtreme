import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadPointCloud() {
    const sourcePath = new URL('../src/packages/pc-render/PointCloud.ts', import.meta.url);
    let source = await readFile(sourcePath, 'utf8');
    source = source
        .replace("import * as THREE from 'three';", 'const THREE = { EventDispatcher: class {} };')
        .replace("import RenderView from './renderView/Render';", '')
        .replace("import { Box, Rect, Box2D } from './objects';", '')
        .replace("import { Event } from './config';", 'const Event = {};')
        .replace("import { AnnotateObject, Object2D } from './objects';", '')
        .replace("import { ITransform } from './type';", '')
        .replace("import { isArray } from 'lodash';", 'const isArray = Array.isArray;')
        .replace("import TWEEN from '@tweenjs/tween.js';", 'const TWEEN = { update() {} };')
        .replace("import PointsMaterial from './material/PointsMaterial';", 'class PointsMaterial {}')
        .replace(
            "import { Points } from './points';",
            'class Points { constructor(material) { this.material = material; this.userData = {}; this.geometry = { dispose() {} }; } updateData(data, mask) { this.data = data; this.mask = mask; } updateForceGround() {} }',
        )
        .replace("import type { ForceGroundOperation } from './points/forceGround';", '')
        .replace("import * as _ from 'lodash';", 'const _ = {};');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

test('disposes replaced preview geometry without disposing shared material', async () => {
    const { default: PointCloud } = await loadPointCloud();
    let geometryDisposals = 0;
    let materialDisposals = 0;
    const sharedMaterial = { dispose() { materialDisposals++; } };
    const preview = {
        userData: {},
        geometry: { dispose() { geometryDisposals++; } },
        material: sharedMaterial,
    };
    const groupPoints = {
        children: [preview],
        clear() { this.children = []; },
        add(points) { this.children.push(points); },
    };
    const pointCloud = Object.create(PointCloud.prototype);
    pointCloud.groupPoints = groupPoints;
    pointCloud.chunkPointIds = new Set();
    pointCloud.material = sharedMaterial;
    pointCloud.groundCorrectionMask = [];
    pointCloud.clearDistanceMeasure = () => {};
    pointCloud.render = () => {};

    pointCloud.setPointCloudChunk('chunk-1', { position: [0, 0, 0] });
    pointCloud.setPointCloudChunk('chunk-2', { position: [1, 0, 0] });

    assert.equal(geometryDisposals, 1);
    assert.equal(materialDisposals, 0);
    assert.equal(groupPoints.children.length, 2);
});
