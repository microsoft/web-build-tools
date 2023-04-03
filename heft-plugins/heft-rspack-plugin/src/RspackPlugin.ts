// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type {
  Compiler as RspackCompiler,
  MultiCompiler as RspackMultiCompiler,
  Stats as RspackStats,
  StatsCompilation as RspackStatsCompilation
  // DevServer as RspackDevServer,
} from '@rspack/core';
import { LegacyAdapters, Import, IPackageJson, PackageJsonLookup } from '@rushstack/node-core-library';
import type {
  HeftConfiguration,
  HeftSession,
  IBuildStageContext,
  IBuildStageProperties,
  IBundleSubstage,
  IHeftPlugin,
  ScopedLogger
} from '@rushstack/heft';
import type {
  IRspackConfiguration,
  IRspackBundleSubstageProperties,
  IRspackBuildStageProperties
} from './shared';
import { RspackConfigurationLoader } from './RspackConfigurationLoader';

const PLUGIN_NAME: string = 'RspackPlugin';

/**
 * @internal
 */
export class RspackPlugin implements IHeftPlugin {
  public readonly pluginName: string = PLUGIN_NAME;

  private static _rspackVersion: string | undefined;
  private static _rspack: typeof import('@rspack/core') | undefined;

  private static async _ensureRspackAsync(): Promise<typeof import('@rspack/core')> {
    if (!RspackPlugin._rspack) {
      // eslint-disable-next-line require-atomic-updates
      RspackPlugin._rspack = await import('@rspack/core');
    }

    return RspackPlugin._rspack;
  }

  private static _getRspackVersion(): string {
    if (!RspackPlugin._rspackVersion) {
      const rspackCorePackageJsonPath: string = Import.resolveModule({
        modulePath: '@rspack/core/package.json',
        baseFolderPath: __dirname
      });
      const rspackCorePackageJson: IPackageJson =
        PackageJsonLookup.instance.loadPackageJson(rspackCorePackageJsonPath);

      RspackPlugin._rspackVersion = rspackCorePackageJson.version;
    }

    return RspackPlugin._rspackVersion;
  }

  public apply(heftSession: HeftSession, heftConfiguration: HeftConfiguration): void {
    heftSession.hooks.build.tap(PLUGIN_NAME, (build: IBuildStageContext) => {
      build.hooks.bundle.tap(PLUGIN_NAME, (bundle: IBundleSubstage) => {
        bundle.hooks.configureWebpack.tapPromise(PLUGIN_NAME, async (existingConfiguration: unknown) => {
          const logger: ScopedLogger = heftSession.requestScopedLogger('configure-rspack');
          if (existingConfiguration) {
            logger.terminal.writeVerboseLine(
              'Skipping loading rspack config file because the rspack config has already been set.'
            );
            return existingConfiguration;
          } else {
            return await RspackConfigurationLoader.tryLoadRspackConfigAsync(
              logger,
              heftConfiguration.buildFolder,
              build.properties
            );
          }
        });

        bundle.hooks.run.tapPromise(PLUGIN_NAME, async () => {
          await this._runRspackAsync(
            heftSession,
            heftConfiguration,
            bundle.properties as IRspackBundleSubstageProperties,
            build.properties,
            heftConfiguration.terminalProvider.supportsColor
          );
        });
      });
    });
  }

  private async _runRspackAsync(
    heftSession: HeftSession,
    heftConfiguration: HeftConfiguration,
    bundleSubstageProperties: IRspackBundleSubstageProperties,
    buildProperties: IBuildStageProperties,
    supportsColor: boolean
  ): Promise<void> {
    const rspackConfiguration: IRspackConfiguration | undefined | null =
      bundleSubstageProperties.rspackConfiguration;
    if (!rspackConfiguration) {
      return;
    }

    const logger: ScopedLogger = heftSession.requestScopedLogger('rspack');

    // TODO: Do some version checking

    logger.terminal.writeLine(`Using Rspack version ${RspackPlugin._getRspackVersion()}`);

    let compiler: RspackCompiler | RspackMultiCompiler;
    const { rspack } = await RspackPlugin._ensureRspackAsync();
    if (Array.isArray(rspackConfiguration)) {
      if (rspackConfiguration.length === 0) {
        logger.terminal.writeLine('The rspack configuration is an empty array - nothing to do.');
        return;
      } else {
        compiler = rspack(rspackConfiguration);
      }
    } else {
      compiler = rspack(rspackConfiguration);
    }

    if (buildProperties.serveMode) {
      // TODO: Get dev server configuration working
      // const defaultDevServerOptions: RspackDevServer = {
      //   host: 'localhost',
      //   devMiddleware: {
      //     publicPath: '/',
      //     stats: {
      //       cached: false,
      //       cachedAssets: false,
      //       colors: supportsColor
      //     }
      //   },
      //   client: {
      //     logging: 'info',
      //     webSocketURL: {
      //       port: 8080
      //     }
      //   },
      //   port: 8080
      // };
      // let options: RspackDevServer;
      // if (Array.isArray(rspackConfiguration)) {
      //   const devServerOptions: RspackDevServer[] = rspackConfiguration
      //     .map((configuration) => configuration.devServer)
      //     .filter((devServer): devServer is RspackDevServer => !!devServer);
      //   if (devServerOptions.length > 1) {
      //     logger.emitWarning(
      //       new Error(`Detected multiple webpack devServer configurations, using the first one.`)
      //     );
      //   }
      //   if (devServerOptions.length > 0) {
      //     options = { ...defaultDevServerOptions, ...devServerOptions[0] };
      //   } else {
      //     options = defaultDevServerOptions;
      //   }
      // } else {
      //   options = { ...defaultDevServerOptions, ...rspackConfiguration.devServer };
      // }
      // // Register a plugin to callback after webpack is done with the first compilation
      // // so we can move on to post-build
      // let firstCompilationDoneCallback: (() => void) | undefined;
      // const originalBeforeCallback: typeof options.setupMiddlewares | undefined = options.setupMiddlewares;
      // options.setupMiddlewares = (middlewares, devServer) => {
      //   compiler.hooks.done.tap('heft-webpack-plugin', () => {
      //     if (firstCompilationDoneCallback) {
      //       firstCompilationDoneCallback();
      //       firstCompilationDoneCallback = undefined;
      //     }
      //   });
      //   if (originalBeforeCallback) {
      //     return originalBeforeCallback(middlewares, devServer);
      //   }
      //   return middlewares;
      // };
      // // The webpack-dev-server package has a design flaw, where merely loading its package will set the
      // // WEBPACK_DEV_SERVER environment variable -- even if no APIs are accessed. This environment variable
      // // causes incorrect behavior if Heft is not running in serve mode. Thus, we need to be careful to call require()
      // // only if Heft is in serve mode.
      // const WebpackDevServer: typeof TWebpackDevServer = require(WEBPACK_DEV_SERVER_PACKAGE_NAME);
      // // TODO: the WebpackDevServer accepts a third parameter for a logger. We should make
      // // use of that to make logging cleaner
      // const webpackDevServer: TWebpackDevServer = new WebpackDevServer(options, compiler);
      // await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
      //   firstCompilationDoneCallback = resolve;
      //   // Wrap in promise.resolve due to small issue in the type declaration, return type should be
      //   // webpackDevServer.start(): Promise<void>;
      //   Promise.resolve(webpackDevServer.start()).catch(reject);
      // });
    } else {
      // TODO: Ensure check for too-early loading of webpack-dev-server
      // if (process.env[WEBPACK_DEV_SERVER_ENV_VAR_NAME]) {
      //   logger.emitWarning(
      //     new Error(
      //       `The "${WEBPACK_DEV_SERVER_ENV_VAR_NAME}" environment variable is set, ` +
      //         'which will cause problems when webpack is not running in serve mode. ' +
      //         `(Did a dependency inadvertently load the "${WEBPACK_DEV_SERVER_PACKAGE_NAME}" package?)`
      //     )
      //   );
      // }

      let stats: RspackStats | undefined;
      if (buildProperties.watchMode) {
        try {
          stats = await LegacyAdapters.convertCallbackToPromise(
            (compiler as RspackCompiler).watch.bind(compiler),
            {}
          );
        } catch (e) {
          logger.emitError(e as Error);
        }
      } else {
        try {
          stats = await LegacyAdapters.convertCallbackToPromise(
            (compiler as RspackCompiler).run.bind(compiler)
          );
          await new Promise<void>((resolve, reject) => {
            // The close() function's callback does not return an error.
            // TODO: Ensure that it can't error
            compiler.close(resolve);
          });
        } catch (e) {
          logger.emitError(e as Error);
        }
      }

      if (stats) {
        // eslint-disable-next-line require-atomic-updates
        (buildProperties as IRspackBuildStageProperties).rspackStats = stats;

        this._emitErrors(logger, heftConfiguration.buildFolder, stats);
      }
    }
  }

  private _emitErrors(logger: ScopedLogger, buildFolder: string, stats: RspackStats): void {
    if (stats.hasErrors() || stats.hasWarnings()) {
      const serializedStats: RspackStatsCompilation[] = [stats.toJson('errors-warnings')];

      const errors: Error[] = [];
      const warnings: Error[] = [];

      for (const compilationStats of serializedStats) {
        if (compilationStats.warnings) {
          for (const warning of compilationStats.warnings) {
            warnings.push(this._normalizeError(buildFolder, warning));
          }
        }

        if (compilationStats.errors) {
          for (const error of compilationStats.errors) {
            errors.push(this._normalizeError(buildFolder, error));
          }
        }

        if (compilationStats.children) {
          for (const child of compilationStats.children) {
            serializedStats.push(child);
          }
        }
      }

      for (const warning of warnings) {
        logger.emitWarning(warning);
      }

      for (const error of errors) {
        logger.emitError(error);
      }
    }
  }

  private _normalizeError(buildFolder: string, error: unknown): Error {
    if (error instanceof Error) {
      return error;
    } else {
      // TODO: Handle better formatting of errors
      return error as Error;
      //   let moduleName: string | undefined = error.moduleName;
      //   if (!moduleName && error.moduleIdentifier) {
      //     moduleName = Path.convertToSlashes(nodePath.relative(buildFolder, error.moduleIdentifier));
      //   }

      //   let formattedError: string;
      //   if (error.loc && moduleName) {
      //     formattedError = `${moduleName}:${error.loc} - ${error.message}`;
      //   } else if (moduleName) {
      //     formattedError = `${moduleName} - ${error.message}`;
      //   } else {
      //     formattedError = error.message;
      //   }

      //   return new Error(formattedError);
    }
  }
}
