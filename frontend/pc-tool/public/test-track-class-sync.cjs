const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
    path.resolve(__dirname, '../src/common/Editor.ts'),
    'utf8',
);

assert.match(
    source,
    /function matchesTrackId[\s\S]*candidate\.trackId === trackId/,
);
assert.match(
    source,
    /object instanceof Box &&\s*matchesTrackId\(object\.userData as IUserData, trackId\)/,
);

console.log('track class sync tests passed');
