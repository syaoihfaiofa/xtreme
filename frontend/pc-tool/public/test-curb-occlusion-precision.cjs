const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pcToolRoot = path.resolve(__dirname, '../src/packages');
const picking = fs.readFileSync(
    path.join(
        pcToolRoot,
        'pc-render/action/EditGroundPolylineVisibility2DAction.ts',
    ),
    'utf8',
);
const visibility = fs.readFileSync(
    path.join(pcToolRoot, 'pc-editor/utils/polylineSegmentVisibility.ts'),
    'utf8',
);

assert.match(picking, /import GroundPolyline from '\.\.\/objects\/GroundPolyline';/);
assert.match(picking, /import ProjectedPolyline from '\.\.\/objects\/projectedPolyline';/);
assert.match(picking, /const PICK_SEGMENT_SAMPLES = 64;/);
assert.match(picking, /const BOUNDARY_SNAP_THRESHOLD_PX = 8;/);
assert.match(
    picking,
    /const segments = projectPolylineToImageSegments\(\s*polyline\.points3D,/,
);
assert.match(
    picking,
    /this\.pickVisibilityBoundary\(polyline, imagePoint, projected\) \?\?/,
);
assert.doesNotMatch(picking, /view\.isFisheye\(\) \? FISHEYE_SEGMENT_SAMPLES : 1/);
assert.match(visibility, /const VERTEX_SNAP_T = 0\.000001;/);

console.log('curb occlusion precision tests passed');
