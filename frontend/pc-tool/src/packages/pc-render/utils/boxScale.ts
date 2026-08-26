export interface IBoxScale {
    x: number;
    y: number;
    z: number;
}

export function isFinitePositiveBoxScale(scale: IBoxScale): boolean {
    return (
        Number.isFinite(scale.x) &&
        Number.isFinite(scale.y) &&
        Number.isFinite(scale.z) &&
        scale.x > 0 &&
        scale.y > 0 &&
        scale.z > 0
    );
}

export function getValidWorldUnitsPerPixel(
    cameraLeft: number,
    cameraRight: number,
    containerWidth: number,
): number | null {
    if (
        !Number.isFinite(cameraLeft) ||
        !Number.isFinite(cameraRight) ||
        !Number.isFinite(containerWidth) ||
        containerWidth <= 0
    ) {
        return null;
    }
    const value = (cameraRight - cameraLeft) / containerWidth;
    return Number.isFinite(value) && value > 0 ? value : null;
}
