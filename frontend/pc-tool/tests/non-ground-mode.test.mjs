import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('../src/packages/pc-render/material/PointsMaterial.ts', import.meta.url);
const settingUrl = new URL('../src/components/Tool/Setting.vue', import.meta.url);
const sideRenderViewUrl = new URL('../src/packages/pc-render/renderView/SideRenderView.ts', import.meta.url);

async function loadVertexShader(options) {
    let source = await readFile(sourceUrl, 'utf8');
    source = source
        .replace("import * as THREE from 'three';", 'const THREE = { RawShaderMaterial: class {} };')
        .replace("import { getColorTable } from '../utils';", 'const getColorTable = () => [];')
        .replace(
            "import {\n    AUTO_NON_GROUND_TOLERANCE,\n    FORCE_GROUND_THRESHOLD,\n} from '../points/forceGround';",
            'const AUTO_NON_GROUND_TOLERANCE = 12; const FORCE_GROUND_THRESHOLD = 0.5;',
        )
        .replace('function getShaderCode(', 'export function getShaderCode(');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
        },
    }).outputText;
    const { getShaderCode } = await import(`data:text/javascript,${encodeURIComponent(output)}`);
    return getShaderCode(options).vertex;
}

test('filters ground points without changing the single or height color mode', async () => {
    const source = await readFile(sourceUrl, 'utf8');
    const vertexShader = source
        .replaceAll('${AUTO_NON_GROUND_TOLERANCE}', '12')
        .replaceAll('${FORCE_GROUND_THRESHOLD}', '0.5');

    assert.doesNotMatch(source, /ColorModeEnum\.NON_GROUND/);
    assert.match(vertexShader, /uniform float hideGround;/);
    assert.match(vertexShader, /attribute float forceGround;/);
    assert.match(vertexShader, /forceGround > 0\.5/);
    assert.match(
        vertexShader,
        /hideGround > 0\.0 && \(colorMode == 0\.0 \|\| colorMode == 1\.0\)[\s\S]*?forceGround > 0\.5[\s\S]*?vDiscard = 1\.0/,
    );
});

test('generates force-ground rules before independent intensity and side-view paths', async () => {
    const vertexShader = await loadVertexShader({
        hasIntensity: true,
        hasVelocity: false,
        hasRGB: true,
    });

    const groundRuleIndex = vertexShader.indexOf('forceGround > 0.5');
    const intensityRuleIndex = vertexShader.indexOf('if(openIntensity > 0.0)');
    const sideViewRuleIndex = vertexShader.indexOf('if(sideViewContrast > 0.0)');
    const sideViewBlock = vertexShader.slice(sideViewRuleIndex, vertexShader.indexOf('#endif', sideViewRuleIndex));

    assert.ok(groundRuleIndex >= 0);
    assert.ok(intensityRuleIndex > groundRuleIndex);
    assert.ok(sideViewRuleIndex > 0);
    assert.doesNotMatch(sideViewBlock, /vDiscard = 1\.0/);
});

test('keeps forced ground points in RGB mode while filtering automatic non-ground points', async () => {
    const source = await readFile(sourceUrl, 'utf8');
    const vertexShader = source
        .replaceAll('${AUTO_NON_GROUND_TOLERANCE}', '12')
        .replaceAll('${FORCE_GROUND_THRESHOLD}', '0.5');

    assert.match(
        vertexShader,
        /hideNonGroundRgb > 0\.0[\s\S]*?forceGround <= 0\.5[\s\S]*?abs\(color\.r - intensity\) < 12\.0[\s\S]*?abs\(color\.g - intensity\) < 12\.0[\s\S]*?abs\(color\.b - intensity\) < 12\.0[\s\S]*?vDiscard = 1\.0/,
    );
});

test('uses the shared force-ground threshold for CPU and shader classification', async () => {
    const source = await readFile(sourceUrl, 'utf8');
    const forceGroundSource = await readFile(
        new URL('../src/packages/pc-render/points/forceGround.ts', import.meta.url),
        'utf8',
    );

    assert.match(forceGroundSource, /export const FORCE_GROUND_THRESHOLD = 0\.5/);
    assert.match(
        forceGroundSource,
        /export function isForceGround\(forceGround: number\): boolean[\s\S]*?forceGround > FORCE_GROUND_THRESHOLD/,
    );
    assert.match(forceGroundSource, /export const AUTO_NON_GROUND_TOLERANCE = 12/);
    assert.doesNotMatch(forceGroundSource, /rgbMatchesIntensity/);
    const vertexShader = source
        .replaceAll('${AUTO_NON_GROUND_TOLERANCE}', '12')
        .replaceAll('${FORCE_GROUND_THRESHOLD}', '0.5');
    assert.match(vertexShader, /forceGround > 0\.5/);
    assert.match(vertexShader, /forceGround <= 0\.5/);
});

test('shows the ground filter only for single and height modes', async () => {
    const source = await readFile(settingUrl, 'utf8');

    assert.match(
        source,
        /config\.pointInfo\.hasRGB[\s\S]*?config\.pointInfo\.hasIntensity[\s\S]*?config\.pointColorMode === ColorModeEnum\.PURE[\s\S]*?config\.pointColorMode === ColorModeEnum\.HEIGHT/,
    );
    assert.match(source, /v-model:checked="config\.hideGround"/);
    assert.doesNotMatch(source, /ColorModeEnum\.NON_GROUND/);
});

test('does not override side-view colors for a removed dedicated mode', async () => {
    const source = await readFile(sideRenderViewUrl, 'utf8');

    assert.doesNotMatch(source, /ColorModeEnum\.NON_GROUND/);
    assert.doesNotMatch(source, /colorMode: sideColorMode/);
});
