const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../src/packages');
const imageView = fs.readFileSync(
    path.join(root, 'pc-render/renderView/Image2DRenderView.ts'),
    'utf8',
);
const viewManager = fs.readFileSync(
    path.join(root, 'pc-editor/common/ViewManager.ts'),
    'utf8',
);
const visibility = fs.readFileSync(
    path.join(root, 'pc-editor/utils/polylineSegmentVisibility.ts'),
    'utf8',
);

assert.match(imageView, /visibilityViewKey: string = '';/);
assert.match(viewManager, /view\.visibilityViewKey = String\(index\);/);
assert.match(viewManager, /maxView\.visibilityViewKey = String\(index\);/);
assert.match(visibility, /if \(view\.visibilityViewKey\) \{/);
assert.match(visibility, /CAMERA_VIEW_KEYS\.some\(\(viewKey\) => !viewsByKey\.has\(viewKey\)\)/);
assert.match(visibility, /forceVisible\[index\] \|\|/);
assert.match(visibility, /return effectiveByView\.some\(\(flags\) => flags\[index\]\);/);
assert.doesNotMatch(visibility, /const relevantViews =/);

console.log('curb visibility aggregation tests passed');
