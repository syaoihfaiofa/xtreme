import type { IUserData } from '../type';

const TRACKING_METADATA_KEYS: readonly (keyof IUserData)[] = [
    'trackId',
    'trackName',
    'groupId',
    'classId',
    'classType',
    'motionMode',
    'wallHeight',
    'syncDistance',
    'syncMaxDisappearGap',
    'syncLocationGapMs',
    'showSyncLocationBoundaries',
    'syncSegmentVisibility',
    'dynamicRangeSyncEnabled',
    'dynamicSyncPreviousFrames',
    'dynamicSyncNextFrames',
    'syncPoseSegmentId',
    'syncPoseSegmentsInitialized',
    'syncUseZ',
    'syncYawOffsetDeg',
    'syncXOffsetM',
    'syncYOffsetM',
    'pendingSyncQuarterTurns',
    'occluded',
    'reviewedCorrect',
    'reviewedCorrectVisible',
];

export function getTrackingMetadata(source: IUserData): IUserData {
    const metadata: IUserData = {};
    TRACKING_METADATA_KEYS.forEach((key) => {
        const value = source[key];
        if (value !== undefined) {
            (metadata as Record<string, unknown>)[key] = value;
        }
    });
    if (source.attrs !== undefined) {
        metadata.attrs = JSON.parse(JSON.stringify(source.attrs)) as Record<string, unknown>;
    }
    return metadata;
}
