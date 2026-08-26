const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../src/packages/pc-render');
const groundPolyline = fs.readFileSync(
    path.join(root, 'objects/GroundPolyline.ts'),
    'utf8',
);
const render2D = fs.readFileSync(path.join(root, 'action/Render2DAction.ts'), 'utf8');

assert.match(groundPolyline, /const HIDDEN_LINE_COLOR = 0xffe600;/);
assert.match(groundPolyline, /new THREE\.LineBasicMaterial\(\{\s*color: HIDDEN_LINE_COLOR,/);
assert.doesNotMatch(groundPolyline, /new THREE\.LineDashedMaterial/);
assert.match(groundPolyline, /setBevRenderSegments\(/);

assert.match(render2D, /const HIDDEN_LINE_COLOR = '#ffe600';/);
assert.match(render2D, /getRelevantViewKeysForPolyline\(/);
assert.match(
    render2D,
    /strokeEdges\(hiddenEdges, HIDDEN_LINE_OUTLINE_COLOR, lineWidth \* 6\);/,
);
assert.doesNotMatch(render2D, /const projectedPolylineSourceIds = new Set/);
assert.match(render2D, /if \(!this\.findSourceGroundPolyline\(obj\)\) \{/);
assert.match(
    render2D,
    /visibilityAction\?\.isEnable\(\) === true[\s\S]*this\.renderGroundPolylineProjection/,
);
assert.doesNotMatch(render2D, /context\.setLineDash\(visible \? \[\] : \[6, 4\]\)/);

console.log('curb occlusion style tests passed');
