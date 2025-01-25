// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * api-extractor-lib2-test
 *
 * @remarks
 * This library is consumed by api-extractor-scenarios.
 *
 * @packageDocumentation
 */

/** @public */
export class Lib2Class {
  prop: number;
}

/** @alpha */
export interface Lib2Interface {}

/** @public */
export default class DefaultClass {}

/**
 * Shadows of built-ins get aliased during rollup, which has resulted in tags being ignored when determining correct
 * output for report variants.
 * @internal
 */
export const performance: Performance = globalThis.performance;
