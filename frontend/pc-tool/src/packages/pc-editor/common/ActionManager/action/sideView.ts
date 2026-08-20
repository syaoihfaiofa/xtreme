import { Box, GroundPolygon, GroundPolyline } from 'pc-render';
import Editor from '../../../Editor';
import { define } from '../define';
import * as THREE from 'three';

let offset = 0.02;
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
        const object = getSelectedObject(editor) as Box | GroundPolygon | GroundPolyline;
        if (object instanceof GroundPolygon || object instanceof GroundPolyline) {
            rotate(editor, -Math.PI / 2);
            return;
        }
        const rotation = getRotationZ(Math.PI / 2, -1, object);
        const scale = object.scale.clone();

        let temp = scale.x;
        scale.x = scale.y;
        scale.y = temp;

        editor.cmdManager.execute('update-transform', { object, transform: { rotation, scale } });
    },
});

function getSelectedObject(editor: Editor): Box | GroundPolygon | GroundPolyline | undefined {
    return editor.pc.selection.find(
        (annotate) =>
            annotate instanceof Box ||
            annotate instanceof GroundPolygon ||
            annotate instanceof GroundPolyline,
    ) as Box | GroundPolygon | GroundPolyline | undefined;
}

function translate(editor: Editor, offset: THREE.Vector3): void {
    const object = getSelectedObject(editor);
    if (!object) return;
    if (object instanceof GroundPolygon || object instanceof GroundPolyline) {
        editor.cmdManager.execute(
            object instanceof GroundPolygon ? 'update-ground-polygon-points' : 'update-ground-polyline-points',
            {
            object,
            points: object.points3D.map((point) => point.clone().add(offset)),
            },
        );
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
        editor.cmdManager.execute(
            object instanceof GroundPolygon ? 'update-ground-polygon-points' : 'update-ground-polyline-points',
            {
            object,
            points: object.points3D.map((point) => point.clone().sub(center).applyMatrix4(rotation).add(center)),
            },
        );
        return;
    }

    const rotation = getRotationZ(Math.abs(angle), Math.sign(angle), object);
    editor.cmdManager.execute('update-transform', { object, transform: { rotation } });
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
