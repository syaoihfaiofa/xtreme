const assert = require('assert');

const {
    buildConfig,
    normalizeCanvasPoint,
} = require('./camera-occlusion-calibrator.js');

assert.deepStrictEqual(normalizeCanvasPoint(320, 180, 640, 360), {
    x: 0.5,
    y: 0.5,
});

assert.deepStrictEqual(
    buildConfig([
        [{ x: 0.1, y: 0.8 }, { x: 0.5, y: 0.6 }, { x: 0.9, y: 0.8 }],
        [],
        [],
        [],
    ]),
    {
        version: 1,
        views: {
            0: {
                points: [
                    { x: 0.1, y: 0.8 },
                    { x: 0.5, y: 0.6 },
                    { x: 0.9, y: 0.8 },
                ],
            },
        },
    },
);

console.log('camera occlusion calibrator tests passed');
