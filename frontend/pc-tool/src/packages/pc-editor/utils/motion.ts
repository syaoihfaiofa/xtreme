import { MotionMode } from '../type';

// Classes whose motion mode defaults to fully-independent-per-frame (variable size),
// matching today's default per-frame annotation behavior for a walking person.
const VARIABLE_SIZE_DEFAULT_CLASSES = ['Person'];

export function getDefaultMotionMode(className?: string): MotionMode {
    if (className && VARIABLE_SIZE_DEFAULT_CLASSES.includes(className)) {
        return MotionMode.DYNAMIC_VARIABLE_SIZE;
    }
    return MotionMode.STATIC;
}

export function getMotionModeOptions($$: (key: string) => string) {
    return [
        { value: MotionMode.STATIC, label: $$('motion-static') },
        { value: MotionMode.DYNAMIC_FIXED_SIZE, label: $$('motion-dynamic-fixed-size') },
        { value: MotionMode.DYNAMIC_VARIABLE_SIZE, label: $$('motion-dynamic-variable-size') },
    ];
}
