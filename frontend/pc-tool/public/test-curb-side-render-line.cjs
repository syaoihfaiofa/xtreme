const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
    path.resolve(
        __dirname,
        '../src/packages/pc-render/renderView/SideRenderView.ts',
    ),
    'utf8',
);
const resizeSource = fs.readFileSync(
    path.resolve(
        __dirname,
        '../src/packages/pc-render/action/ResizeTransAction.ts',
    ),
    'utf8',
);

assert.match(
    source,
    /groundPolylineEditLine\.geometry\.setFromPoints\(hasObject3D\.points3D\);\s*this\.groundPolylineEditLine\.geometry\.computeBoundingSphere\(\);/,
);
assert.match(
    source,
    /object instanceof GroundPolyline && object\.isVisibilityBoundaryPoint\(index\)\s*\? 'none'/,
);
assert.match(
    resizeSource,
    /lineStyle:\s*\{\s*stroke:\s*'transparent',\s*'stroke-dasharray':\s*0/,
);

console.log('curb side render line tests passed');
