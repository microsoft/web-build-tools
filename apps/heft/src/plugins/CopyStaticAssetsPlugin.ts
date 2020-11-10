// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { LegacyAdapters, FileSystem, Terminal } from '@rushstack/node-core-library';
import glob from 'glob';
import * as path from 'path';
import * as chokidar from 'chokidar';

import { Async } from '../utilities/Async';
import { performance } from 'perf_hooks';
import { IHeftPlugin } from '../pluginFramework/IHeftPlugin';
import { HeftSession } from '../pluginFramework/HeftSession';
import { HeftConfiguration } from '../configuration/HeftConfiguration';
import { IBuildStageContext, ICompileSubstage } from '../stages/BuildStage';
import { ScopedLogger } from '../pluginFramework/logging/ScopedLogger';
import { CoreConfigFiles } from '../utilities/CoreConfigFiles';
import { ITypeScriptConfigurationJson } from './TypeScriptPlugin/TypeScriptPlugin';

const globEscape: (unescaped: string[]) => string[] = require('glob-escape'); // No @types/glob-escape package exists

const PLUGIN_NAME: string = 'CopyStaticAssetsPlugin';

export interface ISharedCopyStaticAssetsConfiguration {
  /**
   * File extensions that should be copied from the src folder to the destination folder(s)
   */
  fileExtensions?: string[];

  /**
   * Globs that should be explicitly excluded. This takes precedence over globs listed in "includeGlobs" and
   * files that match the file extensions provided in "fileExtensions".
   */
  excludeGlobs?: string[];

  /**
   * Globs that should be explicitly included.
   */
  includeGlobs?: string[];

  /**
   * The folder to which assets should be copied. For example "lib". This defaults to "lib"
   */
  destinationFolderName?: string;

  /**
   * The folder from which assets should be copied. For example, "src". This defaults to "src".
   */
  sourceFolderName?: string;
}

interface ICopyStaticAssetsConfiguration extends ISharedCopyStaticAssetsConfiguration {
  /**
   * The folder(s) to which assets should be copied. For example ["lib", "lib-cjs"]. This defaults to ["lib"]
   *
   * These folders are directly under the folder containing the project's package.json file
   */
  destinationFolderNames: string[];
}

interface ICopyStaticAssetsOptions {
  logger: ScopedLogger;
  buildFolder: string;
  copyStaticAssetsConfiguration: ICopyStaticAssetsConfiguration;
  watchMode: boolean;
}

interface IRunWatchOptions extends ICopyStaticAssetsOptions {
  fileExtensionsGlobPattern: string | undefined;
  resolvedSourceFolderPath: string;
  resolvedDestinationFolderPaths: string[];
}

export class CopyStaticAssetsPlugin implements IHeftPlugin {
  public readonly pluginName: string = PLUGIN_NAME;

  public apply(heftSession: HeftSession, heftConfiguration: HeftConfiguration): void {
    heftSession.hooks.build.tap(PLUGIN_NAME, (build: IBuildStageContext) => {
      build.hooks.compile.tap(PLUGIN_NAME, (compile: ICompileSubstage) => {
        compile.hooks.run.tapPromise(PLUGIN_NAME, async () => {
          const logger: ScopedLogger = heftSession.requestScopedLogger('copy-static-assets');

          const copyStaticAssetsConfiguration: ICopyStaticAssetsConfiguration = await this._loadCopyStaticAssetsConfigurationAsync(
            logger.terminal,
            heftConfiguration
          );
          await this._runCopyAsync({
            logger,
            copyStaticAssetsConfiguration,
            buildFolder: heftConfiguration.buildFolder,
            watchMode: build.properties.watchMode
          });
        });
      });
    });
  }

  private async _loadCopyStaticAssetsConfigurationAsync(
    terminal: Terminal,
    heftConfiguration: HeftConfiguration
  ): Promise<ICopyStaticAssetsConfiguration> {
    const typescriptConfiguration:
      | ITypeScriptConfigurationJson
      | undefined = await CoreConfigFiles.typeScriptConfigurationFileLoader.tryLoadConfigurationFileForProjectAsync(
      terminal,
      heftConfiguration.buildFolder,
      heftConfiguration.rigConfig
    );

    const destinationFolderNames: string[] = [
      typescriptConfiguration?.staticAssetsToCopy?.destinationFolderName ?? 'lib'
    ];
    for (const emitModule of typescriptConfiguration?.additionalModuleKindsToEmit || []) {
      destinationFolderNames.push(emitModule.outFolderName);
    }

    return {
      ...typescriptConfiguration?.staticAssetsToCopy,
      sourceFolderName: typescriptConfiguration?.staticAssetsToCopy?.sourceFolderName ?? 'src',
      destinationFolderNames
    };
  }

  private async _expandGlobPatternAsync(
    resolvedSourceFolderPath: string,
    pattern: string,
    exclude: string[] | undefined
  ): Promise<Set<string>> {
    const results: string[] = await LegacyAdapters.convertCallbackToPromise(glob, pattern, {
      cwd: resolvedSourceFolderPath,
      nodir: true,
      ignore: exclude
    });

    return new Set<string>(results);
  }

  private async _copyStaticAssetsAsync(
    assetPathsToCopy: string[],
    resolvedSourceFolderPath: string,
    resolvedDestinationFolders: string[]
  ): Promise<number> {
    if (assetPathsToCopy.length === 0) {
      return 0;
    }

    let copyCount: number = 0;
    for (const resolvedDestinationFolder of resolvedDestinationFolders) {
      await Async.forEachLimitAsync(assetPathsToCopy, 100, async (assetPath: string) => {
        await FileSystem.copyFileAsync({
          sourcePath: path.join(resolvedSourceFolderPath, assetPath),
          destinationPath: path.join(resolvedDestinationFolder, assetPath)
        });
        copyCount++;
      });
    }

    return copyCount;
  }

  private async _runCopyAsync(options: ICopyStaticAssetsOptions): Promise<void> {
    const { logger, buildFolder, copyStaticAssetsConfiguration, watchMode } = options;

    if (!copyStaticAssetsConfiguration.sourceFolderName) {
      return;
    }

    const startTime: number = performance.now();
    const resolvedSourceFolderPath: string = path.join(
      buildFolder,
      copyStaticAssetsConfiguration.sourceFolderName
    );
    const resolvedDestinationFolderPaths: string[] = copyStaticAssetsConfiguration.destinationFolderNames.map(
      (destinationFolder) => path.join(buildFolder, destinationFolder)
    );

    let fileExtensionsGlobPattern: string | undefined = undefined;
    if (copyStaticAssetsConfiguration.fileExtensions?.length) {
      const escapedExtensions: string[] = globEscape(copyStaticAssetsConfiguration.fileExtensions);
      fileExtensionsGlobPattern = `**/*+(${escapedExtensions.join('|')})`;
    }

    let assetsToCopy: Set<string>;
    if (copyStaticAssetsConfiguration.fileExtensions?.length) {
      const escapedExtensions: string[] = globEscape(copyStaticAssetsConfiguration.fileExtensions);
      const pattern: string = `**/*+(${escapedExtensions.join('|')})`;
      assetsToCopy = await this._expandGlobPatternAsync(
        resolvedSourceFolderPath,
        pattern,
        copyStaticAssetsConfiguration.excludeGlobs
      );
    } else {
      assetsToCopy = new Set<string>();
    }

    for (const include of copyStaticAssetsConfiguration.includeGlobs || []) {
      const explicitlyIncludedPaths: Set<string> = await this._expandGlobPatternAsync(
        resolvedSourceFolderPath,
        include,
        copyStaticAssetsConfiguration.excludeGlobs
      );
      for (const explicitlyIncludedPath of explicitlyIncludedPaths) {
        assetsToCopy.add(explicitlyIncludedPath);
      }
    }

    const copyCount: number = await this._copyStaticAssetsAsync(
      Array.from(assetsToCopy),
      resolvedSourceFolderPath,
      resolvedDestinationFolderPaths
    );
    const duration: number = performance.now() - startTime;
    logger.terminal.writeLine(
      `Copied ${copyCount} static asset${copyCount === 1 ? '' : 's'} in ${Math.round(duration)}ms`
    );

    if (watchMode) {
      await this._runWatchAsync({
        ...options,
        resolvedSourceFolderPath,
        resolvedDestinationFolderPaths,
        fileExtensionsGlobPattern
      });
    }
  }

  private async _runWatchAsync(options: IRunWatchOptions): Promise<void> {
    const {
      logger,
      fileExtensionsGlobPattern,
      resolvedSourceFolderPath,
      resolvedDestinationFolderPaths,
      copyStaticAssetsConfiguration
    } = options;

    if (fileExtensionsGlobPattern) {
      const watcher: chokidar.FSWatcher = chokidar.watch(
        [fileExtensionsGlobPattern, ...(copyStaticAssetsConfiguration.includeGlobs || [])],
        {
          cwd: resolvedSourceFolderPath,
          ignoreInitial: true,
          ignored: copyStaticAssetsConfiguration.excludeGlobs
        }
      );

      const copyAsset: (assetPath: string) => Promise<void> = async (assetPath: string) => {
        const copyCount: number = await this._copyStaticAssetsAsync(
          [assetPath],
          resolvedSourceFolderPath,
          resolvedDestinationFolderPaths
        );
        logger.terminal.writeLine(`Copied ${copyCount} static asset${copyCount === 1 ? '' : 's'}`);
      };

      watcher.on('add', copyAsset);
      watcher.on('change', copyAsset);
      watcher.on('unlink', (assetPath) => {
        let deleteCount: number = 0;
        for (const resolvedDestinationFolder of resolvedDestinationFolderPaths) {
          FileSystem.deleteFile(path.resolve(resolvedDestinationFolder, assetPath));
          deleteCount++;
        }
        logger.terminal.writeLine(`Deleted ${deleteCount} static asset${deleteCount === 1 ? '' : 's'}`);
      });
    }

    return new Promise(() => {
      /* never resolve */
    });
  }
}
