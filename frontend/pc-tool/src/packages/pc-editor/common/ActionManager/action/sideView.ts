import { Box, GroundPolygon, GroundPolyline, IrregularWall } from 'pc-render';
import Editor from '../../../Editor';
import { MotionMode } from '../../../type';
import { getDefaultMotionMode } from '../../../utils';
import { define } from '../define';
import * as THREE from 'three';

let offset = 0.02;

// Keyboard auto-repeat can produce 30+ events per second.  Updating a wall's
// image projections and BEV visibility for every one of those events is much
// more expensive than moving the geometry itself, especially for long walls.
// Keep the canvas responsive with a local preview and commit once the key burst
// has settled.  The original points are retained for a single correct undo.
let groundPolylinePreview:
    | { object: GroundPolyline; beforePoints: THREE.Vector3[]; timer: number }
    | undefined;
const GROUND_POLYLINE_KEYBOARD_COMMIT_DELAY = 120;
export const translateXPlus = define({
    valid(editor: Editor) {
        return !!getSelectedObject(editor);
    },
    execute(editor: Editor) {
        translate(editor, new THREE.Vector3(offset, 0, 0));
    },
});

export const translateXMinus = define({
    valid(editor: Editor) {
        return !!getSelectedObject(editor);
    },
    execute(editor: Editor) {
        translate(editor, new THREE.Vector3(-offset, 0, 0));
    },
});

export const translateYPlus = define({
    valid(editor: Editor) {
        return !!getSelectedObject(editor);
    },
    execute(editor: Editor) {
        translate(editor, new THREE.Vector3(0, offset, 0));
    },
});

export const translateYMinus = define({
    valid(editor: Editor) {
        return !!getSelectedObject(editor);
    },
    execute(editor: Editor) {
        translate(editor, new THREE.Vector3(0, -offset, 0));
    },
});

export const translateZPlus = define({
    valid(editor: Editor) {
        return !!getSelectedObject(editor);
    },
    execute(editor: Editor) {
        translate(editor, new THREE.Vector3(0, 0, offset));
    },
});

export const translateZMinus = define({
    valid(editor: Editor) {
        return !!getSelectedObject(editor);
    },
    execute(editor: Editor) {
        translate(editor, new THREE.Vector3(0, 0, -offset));
    },
});

export const rotationZLeft = define({
    valid(editor: Editor) {
        return !!getSelectedObject(editor);
    },
    execute(editor: Editor) {
        rotate(editor, offset);
    },
});

export const rotationZRight = define({
    valid(editor: Editor) {
        return !!getSelectedObject(editor);
    },
    execute(editor: Editor) {
        rotate(editor, -offset);
    },
});

export const rotationZRight90 = define({
    valid(editor: Editor) {
        return !!getSelectedObject(editor);
    },
    execute(editor: Editor) {
        const object = getSelectedObject(editor) as Box | GroundPolygon | GroundPolyline | IrregularWall;
        if (object instanceof GroundPolygon || object instanceof GroundPolyline || object instanceof IrregularWall) {
            rotate(editor, -Math.PI / 2);
            return;
        }
        const rotation = getRotationZ(Math.PI / 2, -1, object);
        const scale = object.scale.clone();

        let temp = scale.x;
        scale.x = scale.y;
        scale.y = temp;

        editor.cmdManager.withGroup(() => {
            editor.cmdManager.execute('update-transform', { object, transform: { rotation, scale } });
            // Fixed-size sync normally copies dimensions only.  Record that this dimension
            // change is a C-key orientation switch, so sync can apply the same yaw delta to
            // every target frame instead of leaving swapped dimensions at the old heading.
            const motionMode =
                object.userData?.motionMode || getDefaultMotionMode(object.userData?.classType);
            if (motionMode === MotionMode.DYNAMIC_FIXED_SIZE) {
                const previous = Number(object.userData.pendingSyncQuarterTurns) || 0;
                editor.cmdManager.execute('update-object-user-data', {
                    objects: object,
                    data: { pendingSyncQuarterTurns: previous - 1 },
                });
            }
        });
    },
});

function getSelectedObject(editor: Editor): Box | GroundPolygon | GroundPolyline | IrregularWall | undefined {
    return editor.pc.selection.find(
        (annotate) =>
            annotate instanceof Box ||
            annotate instanceof GroundPolygon ||
            annotate instanceof GroundPolyline ||
            annotate instanceof IrregularWall,
    ) as Box | GroundPolygon | GroundPolyline | IrregularWall | undefined;
}

function translate(editor: Editor, offset: THREE.Vector3): void {
    const object = getSelectedObject(editor);
    if (!object) return;
    if (object instanceof GroundPolygon || object instanceof GroundPolyline) {
        const selectedVertex =
            object instanceof GroundPolygon
                ? editor.getSelectedGroundPolygonVertex()
                : editor.getSelectedGroundPolylineVertex();
        const points = object.points3D.map((point) => point.clone());
        if (selectedVertex?.object === object) {
            points[selectedVertex.index].add(offset);
        } else {
            points.forEach((point) => point.add(offset));
        }
        if (object instanceof GroundPolyline) {
            previewGroundPolylineKeyboardEdit(editor, object, points);
        } else {
            editor.cmdManager.execute('update-ground-polygon-points', { object, points });
        }
        return;
    }
    if (object instanceof IrregularWall) {
        const selectedVertex = editor.getSelectedIrregularWallVertex();
        const bottomPoints = object.bottomPoints.map((point) => point.clone());
        const topPoints = object.topPoints.map((point) => point.clone());
        if (selectedVertex?.object === object) {
            const points = selectedVertex.side === 'bottom' ? bottomPoints : topPoints;
            points[selectedVertex.index]?.add(offset);
            updateIrregularWallPoints(editor, object, bottomPoints, topPoints);
        } else {
            bottomPoints.forEach((point) => point.add(offset));
            topPoints.forEach((point) => point.add(offset));
            updateIrregularWallPoints(editor, object, bottomPoints, topPoints);
        }
        return;
    }

    toWorld(offset, object);
    offset.add(object.position);
    editor.cmdManager.execute('update-transform', { object, transform: { position: offset } });
}

function rotate(editor: Editor, angle: number): void {
    const object = getSelectedObject(editor);
    if (!object) return;
    if (object instanceof GroundPolygon || object instanceof GroundPolyline) {
        const center = object.points3D
            .reduce((sum, point) => sum.add(point), new THREE.Vector3())
            .multiplyScalar(1 / object.points3D.length);
        const rotation = new THREE.Matrix4().makeRotationZ(angle);
        const points = object.points3D.map((point) =>
            point.clone().sub(center).applyMatrix4(rotation).add(center),
        );
        if (object instanceof GroundPolyline) {
            previewGroundPolylineKeyboardEdit(editor, object, points);
        } else {
            editor.cmdManager.execute('update-ground-polygon-points', { object, points });
        }
        return;
    }
    if (object instanceof IrregularWall) {
        const points = [...object.bottomPoints, ...object.topPoints];
        if (points.length < 2) return;
        const center = points
            .reduce((sum, point) => sum.add(point), new THREE.Vector3())
            .multiplyScalar(1 / points.length);
        const rotation = new THREE.Matrix4().makeRotationZ(angle);
        updateIrregularWallPoints(
            editor,
            object,
            object.bottomPoints.map((point) => point.clone().sub(center).applyMatrix4(rotation).add(center)),
            object.topPoints.map((point) => point.clone().sub(center).applyMatrix4(rotation).add(center)),
        );
        return;
    }

    const rotation = getRotationZ(Math.abs(angle), Math.sign(angle), object);
    editor.cmdManager.execute('update-transform', { object, transform: { rotation } });
}

function previewGroundPolylineKeyboardEdit(
    editor: Editor,
    object: GroundPolyline,
    points: THREE.Vector3[],
): void {
    if (groundPolylinePreview?.object !== object) {
        if (groundPolylinePreview) {
            window.clearTimeout(groundPolylinePreview.timer);
            commitGroundPolylineKeyboardPreview(editor, groundPolylinePreview);
        }
        groundPolylinePreview = {
            object,
            beforePoints: object.points3D.map((point) => point.clone()),
            timer: 0,
        };
    }
    object.setPoints(points);
    editor.pc.dispatchEvent({
        type: 'object_transform',
        data: { object, option: { pointsChanged: true } },
    });
    editor.pc.render();
    if (groundPolylinePreview) {
        window.clearTimeout(groundPolylinePreview.timer);
        groundPolylinePreview.timer = window.setTimeout(() => {
            if (!groundPolylinePreview || groundPolylinePreview.object !== object) return;
            const preview = groundPolylinePreview;
            groundPolylinePreview = undefined;
            commitGroundPolylineKeyboardPreview(editor, preview);
        }, GROUND_POLYLINE_KEYBOARD_COMMIT_DELAY);
    }
}

function commitGroundPolylineKeyboardPreview(
    editor: Editor,
    preview: { object: GroundPolyline; beforePoints: THREE.Vector3[] },
): void {
    editor.cmdManager.execute('update-ground-polyline-points', {
        object: preview.object,
        points: preview.object.points3D.map((point) => point.clone()),
        beforePoints: preview.beforePoints,
    });
}

function updateIrregularWallPoints(
    editor: Editor,
    object: IrregularWall,
    bottomPoints: THREE.Vector3[],
    topPoints: THREE.Vector3[],
): void {
    editor.cmdManager.withGroup(() => {
        editor.cmdManager.execute('update-irregular-wall-points', {
            object,
            side: 'bottom',
            points: bottomPoints,
        });
        if (topPoints.length >= 2) {
            editor.cmdManager.execute('update-irregular-wall-points', {
                object,
                side: 'top',
                points: topPoints,
            });
        }
    });
}

let tempV3 = new THREE.Vector3();
function toWorld(offset: THREE.Vector3, object: THREE.Object3D): void {
    const center = tempV3.set(0, 0, 0).applyMatrix4(object.matrixWorld);
    offset.applyMatrix4(object.matrixWorld).sub(center);
}

let tempQuat = new THREE.Quaternion();
let starQuat = new THREE.Quaternion();
let axisDir = new THREE.Vector3(0, 0, 1);
function getRotationZ(angle: number, dir: number, object: THREE.Object3D): THREE.Euler {
    starQuat.setFromEuler(object.rotation);
    tempQuat.setFromAxisAngle(axisDir, dir * angle);
    tempQuat.premultiply(starQuat);

    let rotation = new THREE.Euler();
    rotation.setFromQuaternion(tempQuat);
    return rotation;
}
