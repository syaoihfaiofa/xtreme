(function testCurbOcclusionPicking() {
    const ACTION_NAME = 'edit-ground-polyline-visibility-2d';

    function fail(message, details) {
        console.error(`[curb-occlusion-test] FAIL: ${message}`, details || '');
        return { passed: false, message, details };
    }

    function pass(message, details) {
        console.info(`[curb-occlusion-test] PASS: ${message}`, details || '');
        return { passed: true, message, details };
    }

    function isGroundPolyline(object) {
        return (
            Array.isArray(object?.points3D) &&
            object.points3D.length >= 2 &&
            object.segmentVisibleByView &&
            object.type === 'GroundPolyline'
        );
    }

    function findProjectedSegment(view, polylines) {
        for (const polyline of polylines) {
            for (let segmentIndex = 0; segmentIndex < polyline.points3D.length - 1; segmentIndex++) {
                const start = polyline.points3D[segmentIndex];
                const end = polyline.points3D[segmentIndex + 1];
                const imagePoints = [0.25, 0.75].map((t) =>
                    view.worldToImg(start.clone().lerp(end, t)),
                );
                if (
                    imagePoints.every(
                        (imagePoint) =>
                            Number.isFinite(imagePoint.x) &&
                            Number.isFinite(imagePoint.y) &&
                            imagePoint.x >= 0 &&
                            imagePoint.x <= view.imgSize.x &&
                            imagePoint.y >= 0 &&
                            imagePoint.y <= view.imgSize.y,
                    )
                ) {
                    return { polyline, segmentIndex, imagePoints };
                }
            }
        }
        return null;
    }

    function run() {
        const editor = window.editor;
        if (!editor?.pc) {
            return fail('window.editor is unavailable; open the point-cloud annotation page first');
        }

        const views = editor.pc.renderViews.filter((view) => view.getAction?.(ACTION_NAME));
        const visibleViews = views.filter((view) => {
            const rect = view.container?.getBoundingClientRect();
            return view.isEnable?.() && rect && rect.width > 0 && rect.height > 0;
        });
        const objects = editor.pc.getAnnotate3D?.() || [];
        const polylines = objects.filter(isGroundPolyline);

        console.table({
            modeEnabled: editor.state.config.groundPolylineVisibilityEdit === true,
            imageViewsWithAction: views.length,
            visibleImageViews: visibleViews.length,
            annotate3DObjects: objects.length,
            groundPolylines: polylines.length,
        });

        if (editor.state.config.groundPolylineVisibilityEdit !== true) {
            return fail('occlusion mode is disabled; click the 遮挡 button before running the test');
        }
        if (visibleViews.length === 0) {
            return fail('no visible image view has the occlusion action');
        }
        if (polylines.length === 0) {
            return fail('no GroundPolyline object is loaded', {
                objectTypes: objects.map((object) => ({
                    type: object.type,
                    objectType: object.objectType,
                    constructor: object.constructor?.name,
                })),
            });
        }

        for (const view of visibleViews) {
            const action = view.getAction(ACTION_NAME);
            if (!action?.isEnable?.()) {
                continue;
            }
            const target = findProjectedSegment(view, polylines);
            if (!target) {
                continue;
            }

            action.clearPending();
            const domPoints = target.imagePoints.map((imagePoint) => {
                const domPoint = imagePoint.clone();
                view.imgToDom(domPoint);
                return domPoint;
            });
            const rect = view.container.getBoundingClientRect();
            const eventTarget = view.container.parentElement || view.container;
            let windowReceivedPointer = false;
            const observePointer = () => {
                windowReceivedPointer = true;
            };
            const dispatchPick = (domPoint) => {
                eventTarget.dispatchEvent(
                    new PointerEvent('pointerdown', {
                        bubbles: true,
                        cancelable: true,
                        button: 0,
                        clientX: rect.left + domPoint.x,
                        clientY: rect.top + domPoint.y,
                    }),
                );
            };
            const viewId = view.renderId || view.id;
            const viewKey = viewId.match(/[0-9]{1,5}$/)?.[0] || view.id;
            const pointCountBefore = target.polyline.points3D.length;
            const flagsBefore = target.polyline.getSegmentVisibleForView(viewKey);

            window.addEventListener('pointerdown', observePointer, true);
            dispatchPick(domPoints[0]);
            window.removeEventListener('pointerdown', observePointer, true);

            const pendingPointCreated = action.pendingImagePoint !== null;
            if (pendingPointCreated) {
                dispatchPick(domPoints[1]);
            }
            const flagsAfterToggle = target.polyline.getSegmentVisibleForView(viewKey);
            const pointCountAfter = target.polyline.points3D.length;
            const visibilityChanged =
                JSON.stringify(flagsAfterToggle) !== JSON.stringify(flagsBefore);

            if (visibilityChanged) {
                dispatchPick(domPoints[0]);
                dispatchPick(domPoints[1]);
            }
            const flagsAfterRestore = target.polyline.getSegmentVisibleForView(viewKey);
            const expectedRestoredFlags = [
                ...flagsBefore.slice(0, target.segmentIndex),
                flagsBefore[target.segmentIndex],
                flagsBefore[target.segmentIndex],
                flagsBefore[target.segmentIndex],
                ...flagsBefore.slice(target.segmentIndex + 1),
            ];
            const stateRestored =
                JSON.stringify(flagsAfterRestore) === JSON.stringify(expectedRestoredFlags);

            const details = {
                viewId,
                actionEnabled: action.isEnable(),
                windowReceivedPointer,
                segmentIndex: target.segmentIndex,
                imagePoints: target.imagePoints.map((point) => ({
                    x: Math.round(point.x),
                    y: Math.round(point.y),
                })),
                pendingPointCreated,
                visibilityChanged,
                exactBoundaryPointsCreated: pointCountAfter > pointCountBefore,
                stateRestored,
            };
            console.table(details);

            if (!windowReceivedPointer) {
                return fail('synthetic pointer event did not reach window capture', details);
            }
            if (!pendingPointCreated) {
                return fail('event reached the action, but projected curb segment was not picked', details);
            }
            if (!visibilityChanged) {
                return fail('selecting the same segment twice did not toggle its visibility', details);
            }
            if (pointCountAfter <= pointCountBefore) {
                return fail('exact visibility boundaries were not created', details);
            }
            if (!stateRestored) {
                return fail('the second toggle did not restore the original visibility state', details);
            }

            action.clearPending();
            return pass('curb segment picking and visibility toggling completed successfully', details);
        }

        return fail('no enabled image view contains a projectable GroundPolyline segment', {
            actions: visibleViews.map((view) => ({
                viewId: view.renderId || view.id,
                enabled: view.getAction(ACTION_NAME)?.isEnable?.(),
            })),
        });
    }

    window.testCurbOcclusionPicking = run;
    run();
})();
