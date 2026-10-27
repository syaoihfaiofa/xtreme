import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceUrl = new URL('../src/packages/pc-render/material/PointsMaterial.ts', import.meta.url);
const settingUrl = new URL('../src/components/Tool/Setting.vue', import.meta.url);
const zhLocaleUrl = new URL('../src/components/Tool/lang/zh.ts', import.meta.url);
const enLocaleUrl = new URL('../src/components/Tool/lang/en.ts', import.meta.url);
const sideRenderViewUrl = new URL('../src/packages/pc-render/renderView/SideRenderView.ts', import.meta.url);

test('adds a dedicated shader mode that keeps encoded non-ground points', async () => {
    const source = await readFile(sourceUrl, 'utf8');

    assert.match(source, /NON_GROUND = 4\.0/);
    assert.match(
        source,
        /else if\(colorMode == 4\.0\)[\s\S]*?abs\(color\.r - intensity\) < 12\.0[\s\S]*?abs\(color\.g - intensity\) < 12\.0[\s\S]*?abs\(color\.b - intensity\) < 12\.0[\s\S]*?vDiscard = 1\.0/,
    );
});

test('shows the non-ground mode only when RGB and intensity are available', async () => {
    const source = await readFile(settingUrl, 'utf8');

    assert.match(source, /config\.pointInfo\.hasRGB && config\.pointInfo\.hasIntensity/);
    assert.match(source, /:value="ColorModeEnum\.NON_GROUND"/);
    assert.match(source, /\$\$\('setting_colornonground'\)/);
});

test('localizes the non-ground mode in Chinese and English', async () => {
    const [zhSource, enSource] = await Promise.all([
        readFile(zhLocaleUrl, 'utf8'),
        readFile(enLocaleUrl, 'utf8'),
    ]);

    assert.match(zhSource, /setting_colornonground: '非地面点'/);
    assert.match(enSource, /setting_colornonground: 'Non-ground'/);
});

test('keeps full RGB context in side views for the non-ground mode', async () => {
    const source = await readFile(sideRenderViewUrl, 'utf8');

    assert.match(
        source,
        /ColorModeEnum\.NON_GROUND\s*\?\s*ColorModeEnum\.RGB\s*:\s*oldColorMode/,
    );
    assert.match(source, /colorMode: sideColorMode/);
    assert.match(source, /colorMode: oldColorMode/);
});
