// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type * as rspack from '@rspack/core';
import type { IBuildStageProperties, IBundleSubstageProperties } from '@rushstack/heft';

/**
 * @public
 */
export type IRspackConfiguration = rspack.Configuration | rspack.Configuration[] | undefined;

/**
 * @public
 */
export interface IRspackBundleSubstageProperties extends IBundleSubstageProperties {
  /**
   * The configuration used by the rspack plugin. This must be populated
   * for rspack to run. If rspackConfigFilePath is specified,
   * this will be populated automatically with the exports of the
   * config file referenced in that property.
   *
   * @remarks
   * Tapable event handlers can return `null` instead of `undefined` to suppress
   * other handlers from creating a configuration object.
   */
  // We are inheriting this problem from Tapable's API
  // eslint-disable-next-line @rushstack/no-new-null
  rspackConfiguration?: rspack.Configuration | rspack.Configuration[] | null;
}

/**
 * @public
 */
export interface IRspackBuildStageProperties extends IBuildStageProperties {
  rspackStats?: rspack.Stats;
}
