(function testCameraOcclusionMasks() {
    const editor = window.editor;
    const fail = (message, details) => {
        console.error(`[camera-occlusion-mask-test] FAIL: ${message}`, details || '');
        return false;
    };
    if (!editor?.pc) {
        fail('window.editor is unavailable');
        return;
    }

    const imageViews = editor.pc.renderViews.filter(
        (view) =>
            typeof view.isImagePointAutoVisible === 'function' &&
            view.isEnable?.() &&
            view.container?.getBoundingClientRect().width > 0,
    );
    if (imageViews.length === 0) {
        fail('no visible image views are available');
        return;
    }

    const results = imageViews.map((view) => {
        const viewId = view.renderId || view.id;
        const viewKey = viewId.match(/[0-9]{1,5}$/)?.[0] || view.id;
        const maskPoints = view.option?.occlusionMask || [];
        let hiddenSamples = 0;
        let visibleSamples = 0;
        for (let yIndex = 0; yIndex <= 20; yIndex++) {
            for (let xIndex = 0; xIndex <= 20; xIndex++) {
                const point = {
                    x: (view.imgSize.x * xIndex) / 20,
                    y: (view.imgSize.y * yIndex) / 20,
                };
                if (view.isImagePointAutoVisible(point)) {
                    visibleSamples += 1;
                } else {
                    hiddenSamples += 1;
                }
            }
        }
        const outsideImageHidden = !view.isImagePointAutoVisible({ x: -1, y: -1 });
        return {
            viewKey,
            configuredPoints: maskPoints.length,
            hiddenSamples,
            visibleSamples,
            outsideImageHidden,
            passed:
                maskPoints.length >= 3 &&
                hiddenSamples > 0 &&
                visibleSamples > 0 &&
                outsideImageHidden,
        };
    });

    console.table(results);
    const failed = results.filter((result) => !result.passed);
    if (failed.length > 0) {
        fail('one or more camera masks failed validation', failed);
        return;
    }
    console.info('[camera-occlusion-mask-test] PASS: all visible camera masks are active');
})();
