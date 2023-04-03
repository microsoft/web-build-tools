// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { IHeftPlugin } from '@rushstack/heft';

import { RspackPlugin } from './RspackPlugin';

export { IRspackConfiguration, IRspackBuildStageProperties, IRspackBundleSubstageProperties } from './shared';

/**
 * @public
 */
export default new RspackPlugin() as IHeftPlugin;
