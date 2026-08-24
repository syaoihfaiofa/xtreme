import * as THREE from 'three';
import { IObject, ObjectType } from 'pc-editor';

interface IKeypointLiftedCandidate extends IObject {
    sourceViewIndexes: number[];
    sourceKeypoints: number[][];
}

function isKeypointLiftedCandidate(candidate: IObject): candidate is IKeypointLiftedCandidate {
    const resultType: unknown = candidate.type;
    const objectType = candidate.objType || resultType;
    const sourceViewIndexes: unknown = candidate.sourceViewIndexes;
    const sourceKeypoints: unknown = candidate.sourceKeypoints;
    return (
        (objectType === ObjectType.TYPE_3D_BOX || objectType === ObjectType.TYPE_GROUND_POLYLINE) &&
        Array.isArray(sourceViewIndexes) &&
        Array.isArray(sourceKeypoints) &&
        sourceViewIndexes.length === sourceKeypoints.length &&
        sourceViewIndexes.every((viewIndex) => Number.isInteger(viewIndex) && viewIndex >= 0) &&
        sourceKeypoints.every(
            (keypoints) =>
                Array.isArray(keypoints) &&
                (objectType === ObjectType.TYPE_3D_BOX
                    ? keypoints.length === 8
                    : keypoints.length >= 4 && keypoints.length % 2 === 0) &&
                keypoints.every((value) => typeof value === 'number' && Number.isFinite(value)),
        )
    );
}

function toSourceAnnotation(
    candidate: IKeypointLiftedCandidate,
    viewIndex: number,
    keypoints: number[],
): IObject {
    const points: THREE.Vector2[] = [];
    for (let index = 0; index < keypoints.length; index += 2) {
        points.push(new THREE.Vector2(keypoints[index], keypoints[index + 1]));
    }
    return {
        objType:
            (candidate.objType || candidate.type) === ObjectType.TYPE_GROUND_POLYLINE
                ? ObjectType.TYPE_2D_GROUND_POLYLINE
                : ObjectType.TYPE_2D_RECT,
        type:
            (candidate.objType || candidate.type) === ObjectType.TYPE_GROUND_POLYLINE
                ? ObjectType.TYPE_2D_GROUND_POLYLINE
                : ObjectType.TYPE_2D_RECT,
        modelClass: candidate.modelClass,
        classType: candidate.classType || candidate.modelClass,
        confidence: candidate.confidence,
        viewIndex,
        points,
        center3D: candidate.center3D,
        rotation3D: candidate.rotation3D,
        size3D: candidate.size3D,
    };
}

export function expandKeypointLiftedCandidates(candidates: IObject[]): IObject[] {
    const objects: IObject[] = [];
    candidates.forEach((candidate) => {
        objects.push(candidate);
        if (!isKeypointLiftedCandidate(candidate)) return;

        candidate.sourceViewIndexes?.forEach((viewIndex, index) => {
            objects.push(toSourceAnnotation(candidate, viewIndex, candidate.sourceKeypoints[index]));
        });
    });
    return objects;
}
