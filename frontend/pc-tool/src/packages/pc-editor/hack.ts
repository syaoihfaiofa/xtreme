import Editor from './Editor';
import * as THREE from 'three';
import {
    SideRenderView,
    ResizeTransAction,
    MainRenderView,
    Image2DRenderView,
    RenderView,
    ITransform,
    TransformControlsAction,
    Render2DTrackAction,
    SelectAction,
    AnnotateObject,
    Edit2DAction,
    Rect,
    Box2D,
    Object2D,
    Box,
    GroundPolygon,
    GroundPolyline,
    IrregularWall,
    ProjectedPolygon,
    ProjectedPolyline,
    ProjectedIrregularWall,
    EditGroundPolylineAction,
    EditIrregularWallAction,
} from 'pc-render';
import * as _ from 'lodash';

export default function hack(editor: Editor) {
    let addRenderView = editor.pc.addRenderView;
    editor.pc.addRenderView = (view: RenderView) => {
        if (view instanceof SideRenderView) {
            hackSideView(editor, view);
        }

        if (view instanceof MainRenderView) {
            hackMainView(editor, view);
        }

        if (view instanceof Image2DRenderView) {
            hackImgView(editor, view);
        }

        addRenderView.call(editor.pc, view);

        editor.viewManager.updateViewAction(view);
    };
}

function hackSideView(editor: Editor, view: SideRenderView) {
    view.onGroundPolylineHeightChange = (object: GroundPolyline, wallHeight: number) => {
        editor.cmdManager.execute('update-ground-polyline-height', { object, wallHeight });
    };
    view.onGroundPolylineSegmentInsert = (
        object: GroundPolyline,
        segmentIndex: number,
        point: THREE.Vector3,
    ) => {
        editor.cmdManager.execute('insert-ground-polyline-point', { object, segmentIndex, point });
        editor.setSelectedGroundPolylineVertex(object, segmentIndex + 1);
    };
    view.onGroundPolylineVertexSelect = (object: GroundPolyline, index: number) => {
        editor.setSelectedGroundPolylineVertex(object, index);
    };
    view.getSelectedGroundPolylineVertex = () => editor.getSelectedGroundPolylineVertex();
    view.onGroundPolygonVertexSelect = (object: GroundPolygon, index: number) => {
        editor.setSelectedGroundPolygonVertex(object, index);
    };
    view.getSelectedGroundPolygonVertex = () => editor.getSelectedGroundPolygonVertex();
    view.onGroundPolygonPointsChange = (object: GroundPolygon, points: THREE.Vector3[]) => {
        editor.cmdManager.execute('update-ground-polygon-points', { object, points });
    };
    view.onGroundPolylinePointsChange = (object: GroundPolyline, points: THREE.Vector3[]) => {
        editor.cmdManager.execute('update-ground-polyline-points', { object, points });
    };
    view.onIrregularWallPointsChange = (
        object: IrregularWall,
        side: 'bottom' | 'top',
        points: THREE.Vector3[],
        beforePoints?: THREE.Vector3[],
    ) => {
        editor.cmdManager.execute('update-irregular-wall-points', { object, side, points, beforePoints });
    };
    view.onIrregularWallVertexSelect = (object, side, index) => {
        editor.setSelectedIrregularWallVertex(object, side, index);
    };
    view.getSelectedIrregularWallVertex = () => editor.getSelectedIrregularWallVertex();
    view.onIrregularWallSegmentInsert = (
        object: IrregularWall,
        side: 'bottom' | 'top',
        segmentIndex: number,
        point: THREE.Vector3,
    ) => {
        const points = (side === 'bottom' ? object.bottomPoints : object.topPoints).map((item) => item.clone());
        points.splice(segmentIndex + 1, 0, point);
        editor.cmdManager.execute('update-irregular-wall-points', { object, side, points });
        editor.setSelectedIrregularWallVertex(object, side, segmentIndex + 1);
    };
    let action = view.getAction('resize-translate') as ResizeTransAction;
    // let updateChange = action.updateChange;
    if (action) {
        action.updateChange = (data: ITransform | null) => {
            if (!data) return;
            editor.cmdManager.execute('update-transform', {
                object: action.renderView.object as THREE.Object3D,
                transform: data,
            });
            action.renderView.updateProjectRect();
        };
    }
}

function hackMainView(editor: Editor, view: MainRenderView) {
    const editIrregularWallAction = view.getAction('edit-irregular-wall') as EditIrregularWallAction;
    if (editIrregularWallAction) {
        editIrregularWallAction.onPointsChange = (object, side, points, beforePoints) => {
            editor.cmdManager.execute('update-irregular-wall-points', { object, side, points, beforePoints });
        };
        editIrregularWallAction.onSegmentInsert = (object, side, segmentIndex, point) => {
            const points = (side === 'bottom' ? object.bottomPoints : object.topPoints).map((item) => item.clone());
            points.splice(segmentIndex + 1, 0, point);
            editor.cmdManager.execute('update-irregular-wall-points', { object, side, points });
            editor.setSelectedIrregularWallVertex(object, side, segmentIndex + 1);
        };
        editIrregularWallAction.onVertexSelect = (object, side, index) => {
            editor.setSelectedIrregularWallVertex(object, side, index);
        };
        editIrregularWallAction.getSelectedVertex = () =>
            editor.getSelectedIrregularWallVertex();
        editIrregularWallAction.onExtendHint = (message) => editor.showMsg('info', message, 4);
    }
    let action = view.getAction('transform-control') as TransformControlsAction;
    if (action) {
        action.updatePosition = _.throttle((position: THREE.Vector3) => {
            editor.cmdManager.execute('update-transform', {
                object: (action.control as any).object as THREE.Object3D,
                transform: { position: position },
            });
        }, 30);
    }

    const editGroundPolylineAction = view.getAction(
        'edit-ground-polyline',
    ) as EditGroundPolylineAction;
    if (editGroundPolylineAction) {
        editGroundPolylineAction.onGroundPolylineHeightChange = (
            object: GroundPolyline,
            wallHeight: number,
        ): void => {
            editor.cmdManager.execute('update-ground-polyline-height', { object, wallHeight });
        };
        editGroundPolylineAction.onGroundPolylineSegmentInsert = (
            object: GroundPolyline,
            segmentIndex: number,
            point: THREE.Vector3,
        ): void => {
            editor.cmdManager.execute('insert-ground-polyline-point', { object, segmentIndex, point });
            editor.setSelectedGroundPolylineVertex(object, segmentIndex + 1);
        };
        editGroundPolylineAction.onGroundPolylineVertexSelect = (
            object: GroundPolyline,
            index: number,
        ): void => {
            editor.setSelectedGroundPolylineVertex(object, index);
        };
        editGroundPolylineAction.getSelectedGroundPolylineVertex = () =>
            editor.getSelectedGroundPolylineVertex();
        editGroundPolylineAction.onGroundPolylinePointsChange = (
            object: GroundPolyline,
            points: THREE.Vector3[],
        ): void => {
            editor.cmdManager.execute('update-ground-polyline-points', {
                object,
                points,
            });
        };
        editGroundPolylineAction.onExtendHint = (message: string): void => {
            editor.showMsg('info', message, 4);
        };
    }

    const editGroundPolygonAction = view.getAction('edit-ground-polygon') as {
        onGroundPolygonPointsChange?: (object: GroundPolygon, points: THREE.Vector3[]) => void;
        onGroundPolygonVertexSelect?: (object: GroundPolygon, index: number) => void;
    };
    if (editGroundPolygonAction) {
        editGroundPolygonAction.onGroundPolygonVertexSelect = (
            object: GroundPolygon,
            index: number,
        ): void => {
            editor.setSelectedGroundPolygonVertex(object, index);
        };
        editGroundPolygonAction.onGroundPolygonPointsChange = (
            object: GroundPolygon,
            points: THREE.Vector3[],
        ): void => {
            editor.cmdManager.execute('update-ground-polygon-points', { object, points });
        };
        editGroundPolygonAction.getSelectedGroundPolygonVertex = () =>
            editor.getSelectedGroundPolygonVertex();
    }

    // let selectAction = view.getAction('select') as SelectAction;
    // if (selectAction) {
    //     selectAction.selectObject = (object?: AnnotateObject) => {
    //         editor.cmdManager.execute('select-object', object);
    //     };
    // }
}

function hackImgView(editor: Editor, view: Image2DRenderView) {
    let selectAction = view.getAction('select') as SelectAction;
    if (selectAction) {
        selectAction.selectObject = (object?: AnnotateObject) => {
            editor.cmdManager.execute('select-object', object);
        };
    }

    const trackAction = view.getAction('render-2d-track') as Render2DTrackAction;
    if (trackAction) {
        trackAction.activeTrack = () => {
            return editor.state.config.activeTrack;
        };
        trackAction.trackCircle = () => {
            return editor.state.config.activeHelper2d.includes('aux_circle');
        };
        trackAction.trackLine = () => {
            return editor.state.config.activeHelper2d.includes('aux_line');
        };
        trackAction.trackRadius = () => {
            return editor.state.config.circleRadius;
        };
    }

    let editAction = view.getAction('edit-2d') as Edit2DAction;
    if (editAction) {
        editAction.getSelectedGroundPolygonVertex = () =>
            editor.getSelectedGroundPolygonVertex();
        editAction.onGroundProjectionPointChange = (
            projection: ProjectedPolygon | ProjectedPolyline,
            index: number,
            imagePoint: THREE.Vector2,
        ) => updateGroundProjectionPoint(editor, view, projection, index, imagePoint, false);
        editAction.onGroundProjectionPointCommit = (
            projection: ProjectedPolygon | ProjectedPolyline,
            index: number,
            imagePoint: THREE.Vector2,
        ) => updateGroundProjectionPoint(editor, view, projection, index, imagePoint, true);
        editAction.onIrregularWallProjectionPointChange = (
            projection: ProjectedIrregularWall,
            side: 'bottom' | 'top',
            index: number,
            imagePoint: THREE.Vector2,
        ) => {
            const sourceId = projection.userData.projectedFromId;
            const trackId = projection.userData.trackId;
            const source = (editor.pc
                .getAnnotate3D() as AnnotateObject[])
                .find((object) => object.uuid === sourceId || (!!trackId && object.userData?.trackId === trackId));
            if (!(source instanceof IrregularWall)) return;
            projection.userData.projectedFromId = source.uuid;
            const sourcePoints = side === 'bottom' ? source.bottomPoints : source.topPoints;
            if (!sourcePoints[index]) return;
            source.updateMatrixWorld(true);
            const vertexHeight = source.localToWorld(sourcePoints[index].clone()).z;
            const worldPoint = view.imgToWorldOnPlane(imagePoint, vertexHeight);
            if (!worldPoint) return;
            const points = sourcePoints.map((point) => point.clone());
            points[index].copy(source.worldToLocal(worldPoint));
            editor.cmdManager.execute('update-irregular-wall-points', {
                object: source,
                side,
                points,
            });
        };
        editAction.updateRectData = (center: THREE.Vector2, size?: THREE.Vector2) => {
            let object = editAction.object as Rect;
            editor.cmdManager.execute('update-2d-rect', { object, option: { center, size } });
        };

        editAction.updateBox2DData = (
            positionName: 'positions1' | 'positions2',
            positionMap: Record<number, THREE.Vector2>,
        ) => {
            let object = editAction.object as Box2D;
            let option = {} as any;
            option[positionName] = positionMap;
            editor.cmdManager.execute('update-2d-box', { object, option });
        };
        editAction.validRect = function (
            center: THREE.Vector2,
            size: THREE.Vector2,
            moveOnly: boolean,
        ) {
            let config = editor.state.config;
            if (config.limitRect2Image) {
                validRect(center, size, view.imgSize, moveOnly);
            }
        };
    }

    let get2DObject = view.get2DObject;
    view.get2DObject = function () {
        let { config } = editor.state;
        let currentTrack = editor.getCurTrack();

        let objects = get2DObject.call(view);
        if (config.filter2DByTrack && currentTrack) {
            return objects.filter((e) => {
                return (
                    e.userData.trackId === currentTrack &&
                    (e instanceof Rect ||
                        e instanceof Box2D ||
                        e instanceof ProjectedPolygon ||
                        e instanceof ProjectedPolyline ||
                        e instanceof ProjectedIrregularWall)
                );
            }) as Object2D[];
        } else {
            return get2DObject.call(view);
        }
    };

    let get3DObject = view.get3DObject;
    view.get3DObject = function () {
        let { config } = editor.state;
        let currentTrack = editor.getCurTrack();

        let objects = get3DObject.call(view) as AnnotateObject[];
        if (config.filter2DByTrack && currentTrack) {
            return objects.filter((e) => {
                return (
                    e.userData.trackId === currentTrack &&
                    (e instanceof Box ||
                        e instanceof GroundPolygon ||
                        e instanceof GroundPolyline ||
                        e instanceof IrregularWall)
                );
            }) as any;
        } else {
            return objects as any;
        }
    };
}

function updateGroundProjectionPoint(
    editor: Editor,
    view: Image2DRenderView,
    projection: ProjectedPolygon | ProjectedPolyline,
    index: number,
    imagePoint: THREE.Vector2,
    snapToPointCloud: boolean,
): void {
    const sourceId = projection.userData.projectedFromId;
    const trackId = projection.userData.trackId;
    const source = (editor.pc.getAnnotate3D() as AnnotateObject[]).find(
        (object) => object.uuid === sourceId || (!!trackId && object.userData?.trackId === trackId),
    );
    if (!(source instanceof GroundPolygon) && !(source instanceof GroundPolyline)) return;
    if (!source.points3D[index]) return;

    projection.userData.projectedFromId = source.uuid;
    source.updateMatrixWorld(true);
    const vertexHeight = source.localToWorld(source.points3D[index].clone()).z;
    const planePoint = view.imgToWorldOnPlane(imagePoint, vertexHeight);
    if (!planePoint) return;

    // Dragging remains smooth because this is false during pointer moves.  On
    // release, use the nearest height-continuous raw return as the final point.
    const worldPoint = snapToPointCloud
        ? snapToCurrentGroundPoint(editor, view, imagePoint, planePoint)
        : planePoint;
    const points = source.points3D.map((point) => point.clone());
    points[index].copy(source.worldToLocal(worldPoint.clone()));
    if (source instanceof GroundPolygon && !GroundPolygon.isValidPoints(points)) return;
    if (source instanceof GroundPolygon) {
        editor.cmdManager.execute('update-ground-polygon-points', { object: source, points });
    } else {
        editor.cmdManager.execute('update-ground-polyline-points', { object: source, points });
    }
}

/**
 * Returns a raw point near both the dragged image pixel and the estimated ground
 * position. The visual density overlay is intentionally excluded: only
 * groupPoints holds the current frame's real LiDAR returns.
 */
function snapToCurrentGroundPoint(
    editor: Editor,
    view: Image2DRenderView,
    imagePoint: THREE.Vector2,
    candidate: THREE.Vector3,
): THREE.Vector3 {
    const maxHorizontalDistance = 0.75;
    const maxHeightDifference = 0.4;
    const maxImageError = 18;
    const maxHorizontalDistanceSq = maxHorizontalDistance * maxHorizontalDistance;
    const maxImageErrorSq = maxImageError * maxImageError;
    let bestPoint: THREE.Vector3 | undefined;
    let bestScore = Infinity;
    const worldPoint = new THREE.Vector3();

    editor.pc.groupPoints.updateMatrixWorld(true);
    editor.pc.groupPoints.children.forEach((child) => {
        if (!(child instanceof THREE.Points)) return;
        const position = (child.geometry as THREE.BufferGeometry).getAttribute('position');
        if (!position) return;
        child.updateMatrixWorld(true);
        for (let index = 0; index < position.count; index++) {
            worldPoint.fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld);
            const dx = worldPoint.x - candidate.x;
            const dy = worldPoint.y - candidate.y;
            const horizontalDistanceSq = dx * dx + dy * dy;
            const heightDifference = Math.abs(worldPoint.z - candidate.z);
            if (horizontalDistanceSq > maxHorizontalDistanceSq || heightDifference > maxHeightDifference) continue;
            const reprojected = view.worldToImg(worldPoint.clone());
            const imageDx = reprojected.x - imagePoint.x;
            const imageDy = reprojected.y - imagePoint.y;
            const imageErrorSq = imageDx * imageDx + imageDy * imageDy;
            if (!Number.isFinite(imageErrorSq) || imageErrorSq > maxImageErrorSq) continue;
            // The selected raw point must first stay on the image ray.  BEV
            // distance and height only break ties between points that project
            // near the cursor, avoiding a visually noticeable snap sideways.
            const score = imageErrorSq + horizontalDistanceSq * 16 + heightDifference * heightDifference * 4;
            if (score < bestScore) {
                bestScore = score;
                bestPoint = worldPoint.clone();
            }
        }
    });
    return bestPoint || candidate;
}

function validRect(
    center: THREE.Vector2,
    size: THREE.Vector2,
    imgSize: THREE.Vector2,
    moveOnly: boolean,
) {
    if (moveOnly) {
        // x
        if (center.x - size.x / 2 < 0) center.x = size.x / 2;
        if (center.x + size.x / 2 > imgSize.x) center.x = imgSize.x - size.x / 2;
        // y
        if (center.y - size.y / 2 < 0) center.y = size.y / 2;
        if (center.y + size.y / 2 > imgSize.y) center.y = imgSize.y - size.y / 2;
    } else {
        let rx = THREE.MathUtils.clamp(center.x + size.x / 2, 0, imgSize.x);
        let lx = THREE.MathUtils.clamp(center.x - size.x / 2, 0, imgSize.x);
        let ty = THREE.MathUtils.clamp(center.y - size.y / 2, 0, imgSize.y);
        let by = THREE.MathUtils.clamp(center.y + size.y / 2, 0, imgSize.y);
        center.set((rx + lx) / 2, (by + ty) / 2);
        size.set(rx - lx, by - ty);
    }
}
