// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { type FolderItem, FileSystem } from '@rushstack/node-core-library';
import type * as rspack from '@rspack/core';
import type { IBuildStageProperties, ScopedLogger } from '@rushstack/heft';

import { IRspackConfiguration } from './shared';

interface IRspackConfigFunctionEnv {
  prod: boolean;
  production: boolean;
}
type IRspackConfigJsExport =
  | rspack.Configuration
  | rspack.Configuration[]
  | Promise<rspack.Configuration>
  | Promise<rspack.Configuration[]>
  | ((env: IRspackConfigFunctionEnv) => rspack.Configuration | rspack.Configuration[])
  | ((env: IRspackConfigFunctionEnv) => Promise<rspack.Configuration | rspack.Configuration[]>);
type IRspackConfigJs = IRspackConfigJsExport | { default: IRspackConfigJsExport };

interface IRspackConfigFileNames {
  dev: string | undefined;
  prod: string | undefined;
}

export class RspackConfigurationLoader {
  public static async tryLoadRspackConfigAsync(
    logger: ScopedLogger,
    buildFolder: string,
    buildProperties: IBuildStageProperties
  ): Promise<IRspackConfiguration | undefined> {
    const rspackConfigFiles: IRspackConfigFileNames | undefined = await findRspackConfigAsync(buildFolder);
    const rspackDevConfigFilename: string | undefined = rspackConfigFiles.dev;
    const rspackConfigFilename: string | undefined = rspackConfigFiles.prod;

    let rspackConfigJs: IRspackConfigJs | undefined;

    try {
      if (buildProperties.serveMode && rspackDevConfigFilename) {
        logger.terminal.writeVerboseLine(
          `Attempting to load rspack configuration from "${rspackDevConfigFilename}".`
        );
        rspackConfigJs = RspackConfigurationLoader._tryLoadRspackConfiguration(
          buildFolder,
          rspackDevConfigFilename
        );
      }

      if (!rspackConfigJs && rspackConfigFilename) {
        logger.terminal.writeVerboseLine(
          `Attempting to load rspack configuration from "${rspackConfigFilename}".`
        );
        rspackConfigJs = RspackConfigurationLoader._tryLoadRspackConfiguration(
          buildFolder,
          rspackConfigFilename
        );
      }
    } catch (error) {
      logger.emitError(error as Error);
    }

    if (rspackConfigJs) {
      const rspackConfig: IRspackConfigJsExport =
        (rspackConfigJs as { default: IRspackConfigJsExport }).default || rspackConfigJs;

      if (typeof rspackConfig === 'function') {
        return rspackConfig({ prod: buildProperties.production, production: buildProperties.production });
      } else {
        return rspackConfig;
      }
    } else {
      return undefined;
    }
  }

  private static _tryLoadRspackConfiguration(
    buildFolder: string,
    configurationFilename: string
  ): IRspackConfigJs | undefined {
    const fullRspackConfigPath: string = path.join(buildFolder, configurationFilename);
    if (FileSystem.exists(fullRspackConfigPath)) {
      try {
        return require(fullRspackConfigPath);
      } catch (e) {
        throw new Error(`Error loading rspack configuration at "${fullRspackConfigPath}": ${e}`);
      }
    } else {
      return undefined;
    }
  }
}

async function findRspackConfigAsync(buildFolder: string): Promise<IRspackConfigFileNames> {
  try {
    const folderItems: FolderItem[] = await FileSystem.readFolderItemsAsync(buildFolder);
    const dev: string[] = [];
    const prod: string[] = [];

    for (const folderItem of folderItems) {
      if (folderItem.isFile()) {
        if (folderItem.name.match(/^rspack.dev.config\.(cjs|js|mjs)$/)) {
          dev.push(folderItem.name);
        } else if (folderItem.name.match(/^rspack.config\.(cjs|js|mjs)$/)) {
          prod.push(folderItem.name);
        }
      }
    }

    if (dev.length > 1) {
      throw new Error(`Error: Found more than one dev rspack configuration file.`);
    } else if (prod.length > 1) {
      throw new Error(`Error: Found more than one non-dev rspack configuration file.`);
    }

    return {
      dev: dev[0],
      prod: prod[0]
    };
  } catch (e) {
    throw new Error(`Error finding rspack configuration: ${e}`);
  }
}
