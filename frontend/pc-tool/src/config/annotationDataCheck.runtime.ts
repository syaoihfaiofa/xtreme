import rawConfig from './annotationDataCheck.json';

import {
    AnnotationDataCheckJsonConfig,
    buildAnnotationDataCheckConfig,
} from './annotationDataCheckConfig';

export const ANNOTATION_DATA_CHECK_CONFIG = buildAnnotationDataCheckConfig(
    rawConfig as AnnotationDataCheckJsonConfig,
);
