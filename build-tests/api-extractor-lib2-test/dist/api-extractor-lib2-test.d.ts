/**
 * api-extractor-lib2-test
 *
 * @remarks
 * This library is consumed by api-extractor-scenarios.
 *
 * @packageDocumentation
 */

/** @public */
declare class DefaultClass {
}
export default DefaultClass;

/** @public */
export declare class Lib2Class {
    prop: number;
}

/** @alpha */
export declare interface Lib2Interface {
}

/**
 * Shadows of built-ins get aliased during rollup, which has resulted in tags being ignored when determining correct
 * output for report variants.
 * @internal
 */
declare const performance_2: Performance;
export { performance_2 as performance }

export { }
