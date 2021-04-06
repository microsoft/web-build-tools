// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { IHeftPlugin } from './IHeftPlugin';

import { CopyFilesPlugin } from '../plugins/CopyFilesPlugin';
import { TypeScriptPlugin } from '../plugins/TypeScriptPlugin/TypeScriptPlugin';
import { DeleteGlobsPlugin } from '../plugins/DeleteGlobsPlugin';
import { CopyStaticAssetsPlugin } from '../plugins/CopyStaticAssetsPlugin';
import { ApiExtractorPlugin } from '../plugins/ApiExtractorPlugin/ApiExtractorPlugin';
import { JestPlugin } from '../plugins/JestPlugin/JestPlugin';
import { BasicConfigureWebpackPlugin } from '../plugins/Webpack/BasicConfigureWebpackPlugin';
import { WebpackPlugin } from '../plugins/Webpack/WebpackPlugin';
import { SassTypingsPlugin } from '../plugins/SassTypingsPlugin/SassTypingsPlugin';
import { ProjectValidatorPlugin } from '../plugins/ProjectValidatorPlugin';
import { ToolPackageResolver } from '../utilities/ToolPackageResolver';

export function getDefaultPlugins(): Iterable<IHeftPlugin> {
  const taskPackageResolver: ToolPackageResolver = new ToolPackageResolver();

  return [
    new TypeScriptPlugin(taskPackageResolver),
    new CopyStaticAssetsPlugin(),
    new CopyFilesPlugin(),
    new DeleteGlobsPlugin(),
    new ApiExtractorPlugin(taskPackageResolver),
    new JestPlugin(),
    new BasicConfigureWebpackPlugin(),
    new WebpackPlugin(),
    new SassTypingsPlugin(),
    new ProjectValidatorPlugin()
  ];
}
