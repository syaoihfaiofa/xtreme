import * as THREE from 'three';

export interface IPolylineProjectionView {
    key: string;
    width: number;
    height: number;
    project: (point: THREE.Vector3) => { x: number; y: number };
}

export interface IImageBoundaryOcclusionResult {
    points: THREE.Vector3[];
    segmentVisibleByView: Record<string, boolean[]>;
    changed: boolean;
}

const BOUNDARY_SEARCH_SAMPLES = 128;
const BOUNDARY_SEARCH_ITERATIONS = 24;
const PARAMETER_EPSILON = 0.000001;

function isInside(
    point: { x: number; y: number },
    view: IPolylineProjectionView,
): boolean {
    return (
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.x <= view.width &&
        point.y >= 0 &&
        point.y <= view.height
    );
}

function isPointInsideView(
    start: THREE.Vector3,
    end: THREE.Vector3,
    parameter: number,
    view: IPolylineProjectionView,
): boolean {
    return isInside(view.project(start.clone().lerp(end, parameter)), view);
}

function findBoundaryParameter(
    start: THREE.Vector3,
    end: THREE.Vector3,
    from: number,
    to: number,
    view: IPolylineProjectionView,
): number {
    let low = from;
    let high = to;
    const lowInside = isPointInsideView(start, end, low, view);
    for (let iteration = 0; iteration < BOUNDARY_SEARCH_ITERATIONS; iteration++) {
        const middle = (low + high) / 2;
        if (isPointInsideView(start, end, middle, view) === lowInside) {
            low = middle;
        } else {
            high = middle;
        }
    }
    return (low + high) / 2;
}

function collectBoundaryParameters(
    start: THREE.Vector3,
    end: THREE.Vector3,
    views: readonly IPolylineProjectionView[],
): number[] {
    const parameters: number[] = [];
    views.forEach((view) => {
        let previousParameter = 0;
        let previousInside = isPointInsideView(start, end, previousParameter, view);
        for (let sampleIndex = 1; sampleIndex <= BOUNDARY_SEARCH_SAMPLES; sampleIndex++) {
            const parameter = sampleIndex / BOUNDARY_SEARCH_SAMPLES;
            const inside = isPointInsideView(start, end, parameter, view);
            if (inside !== previousInside) {
                parameters.push(
                    findBoundaryParameter(
                        start,
                        end,
                        previousParameter,
                        parameter,
                        view,
                    ),
                );
            }
            previousParameter = parameter;
            previousInside = inside;
        }
    });
    return parameters
        .filter(
            (parameter) =>
                parameter > PARAMETER_EPSILON && parameter < 1 - PARAMETER_EPSILON,
        )
        .sort((left, right) => left - right)
        .filter(
            (parameter, index, sorted) =>
                index === 0 || parameter - sorted[index - 1] > PARAMETER_EPSILON,
        );
}

export function computeImageBoundaryOcclusion(
    points: readonly THREE.Vector3[],
    segmentVisibleByView: Readonly<Record<string, readonly boolean[]>>,
    views: readonly IPolylineProjectionView[],
): IImageBoundaryOcclusionResult {
    if (points.length < 2) {
        throw new Error(`Ground polyline requires at least two points; received ${points.length}`);
    }
    const nextPoints: THREE.Vector3[] = [points[0].clone()];
    const nextByView: Record<string, boolean[]> = {};
    views.forEach((view) => {
        nextByView[view.key] = [];
    });

    for (let segmentIndex = 0; segmentIndex < points.length - 1; segmentIndex++) {
        const start = points[segmentIndex];
        const end = points[segmentIndex + 1];
        const parameters = [0, ...collectBoundaryParameters(start, end, views), 1];
        for (let intervalIndex = 1; intervalIndex < parameters.length; intervalIndex++) {
            const from = parameters[intervalIndex - 1];
            const to = parameters[intervalIndex];
            const middle = (from + to) / 2;
            views.forEach((view) => {
                const manuallyVisible =
                    segmentVisibleByView[view.key]?.[segmentIndex] !== false;
                nextByView[view.key].push(
                    manuallyVisible && isPointInsideView(start, end, middle, view),
                );
            });
            nextPoints.push(end.clone().lerp(start, 1 - to));
        }
    }

    const changed =
        nextPoints.length !== points.length ||
        views.some((view) => {
            const previous = segmentVisibleByView[view.key] ?? [];
            const next = nextByView[view.key];
            return (
                previous.length !== next.length ||
                next.some((visible, index) => previous[index] !== visible)
            );
        });
    return {
        points: nextPoints,
        segmentVisibleByView: nextByView,
        changed,
    };
}
