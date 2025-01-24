// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { createHash } from 'crypto';

import type { Comment } from 'estree';
import type {
  Module,
  Compilation,
  WebpackPluginInstance,
  Compiler,
  javascript,
  WebpackError,
  ExternalModule,
  sources,
  Chunk
} from 'webpack';
import { AsyncSeriesWaterfallHook, SyncWaterfallHook, type Tap } from 'tapable';

import {
  CHUNK_MODULE_TOKEN,
  MODULE_WRAPPER_PREFIX,
  MODULE_WRAPPER_SUFFIX,
  STAGE_BEFORE,
  STAGE_AFTER
} from './Constants';
import type {
  IMinifierConnection,
  IModuleMinifier,
  IModuleMinificationResult,
  IModuleMinificationErrorResult
} from '@rushstack/module-minifier';
import { getIdentifier } from '@rushstack/module-minifier';

import type {
  IModuleMinifierPluginOptions,
  IModuleMap,
  IAssetMap,
  IFactoryMeta,
  IModuleMinifierPluginHooks,
  IPostProcessFragmentContext,
  IDehydratedAssets,
  IModuleStats,
  IModuleMinifierPluginStats as IModuleMinifierPluginStats,
  IAssetStats
} from './ModuleMinifierPlugin.types';

import { generateLicenseFileForAsset } from './GenerateLicenseFileForAsset';
import { rehydrateAsset } from './RehydrateAsset';
import { AsyncImportCompressionPlugin } from './AsyncImportCompressionPlugin';

// The name of the plugin, for use in taps
const PLUGIN_NAME: 'ModuleMinifierPlugin' = 'ModuleMinifierPlugin';

// Monotonically increasing identifier to be incremented any time the code generation logic changes
// Will be applied to the webpack hash.
const CODE_GENERATION_REVISION: number = 1;
// Match behavior of terser's "some" option
// https://github.com/terser/terser/blob/d3d924fa9e4c57bbe286b811c6068bcc7026e902/lib/output.js#L175
const LICENSE_COMMENT_REGEX: RegExp = /@preserve|@lic|@cc_on|^\**!/i;

const TAP_BEFORE: Tap = {
  name: PLUGIN_NAME,
  stage: STAGE_BEFORE
};
const TAP_AFTER: Tap = {
  name: PLUGIN_NAME,
  stage: STAGE_AFTER
};

interface IOptionsForHash extends Omit<IModuleMinifierPluginOptions, 'minifier'> {
  revision: number;
  minifier: undefined;
}

interface ISourceCacheEntry {
  source: sources.Source;
  hash: string;
}

const compilationMetadataMap: WeakMap<Compilation, IModuleMinifierPluginStats> = new WeakMap();

function hashCodeFragment(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Base implementation of asset rehydration
 *
 * @param dehydratedAssets The dehydrated assets
 * @param compilation The webpack compilation
 */
function defaultRehydrateAssets(
  dehydratedAssets: IDehydratedAssets,
  compilation: Compilation
): IDehydratedAssets {
  const { assets, modules } = dehydratedAssets;

  const compilationMetadata: IModuleMinifierPluginStats | undefined = compilationMetadataMap.get(compilation);
  if (!compilationMetadata) {
    throw new Error(`Could not get compilation metadata`);
  }

  const { metadataByAssetFileName } = compilationMetadata;

  // Now assets/modules contain fully minified code. Rehydrate.
  for (const [assetName, info] of assets) {
    const banner: string = info.type === 'javascript' ? generateLicenseFileForAsset(compilation, info) : '';

    const replacementSource: sources.Source = rehydrateAsset(compilation, info, modules, banner, true);
    metadataByAssetFileName.set(assetName, {
      positionByModuleId: info.renderInfo
    });
    compilation.updateAsset(assetName, replacementSource);
  }

  return dehydratedAssets;
}

function isMinificationResultError(
  result: IModuleMinificationResult
): result is IModuleMinificationErrorResult {
  return !!result.error;
}

function isLicenseComment(comment: Comment): boolean {
  return LICENSE_COMMENT_REGEX.test(comment.value);
}

/**
 * Webpack plugin that minifies code on a per-module basis rather than per-asset. The actual minification is handled by the input `minifier` object.
 * @public
 */
export class ModuleMinifierPlugin implements WebpackPluginInstance {
  public readonly hooks: IModuleMinifierPluginHooks;
  public minifier: IModuleMinifier;

  private readonly _enhancers: WebpackPluginInstance[];
  private readonly _sourceMap: boolean | undefined;

  private readonly _optionsForHash: IOptionsForHash;

  public constructor(options: IModuleMinifierPluginOptions) {
    this.hooks = {
      rehydrateAssets: new AsyncSeriesWaterfallHook(['dehydratedContent', 'compilation']),

      postProcessCodeFragment: new SyncWaterfallHook(['code', 'context'])
    };

    const { minifier, sourceMap, compressAsyncImports = false } = options;

    this._optionsForHash = {
      ...options,
      minifier: undefined,
      revision: CODE_GENERATION_REVISION
    };

    this._enhancers = [];

    if (compressAsyncImports) {
      this._enhancers.push(new AsyncImportCompressionPlugin(this.hooks));
    }

    this.hooks.rehydrateAssets.tap(PLUGIN_NAME, defaultRehydrateAssets);
    this.minifier = minifier;

    this._sourceMap = sourceMap;
  }

  public static getCompilationStatistics(compilation: Compilation): IModuleMinifierPluginStats | undefined {
    return compilationMetadataMap.get(compilation);
  }

  public apply(compiler: Compiler): void {
    for (const enhancer of this._enhancers) {
      enhancer.apply(compiler);
    }

    const {
      options: { devtool, mode },
      webpack
    } = compiler;

    webpack.Template.numberToIdentifier = getIdentifier;

    const { CachedSource, ConcatSource, RawSource, ReplaceSource, SourceMapSource } = webpack.sources;
    // The explicit setting is preferred due to accuracy, but try to guess based on devtool
    const useSourceMaps: boolean =
      typeof this._sourceMap === 'boolean'
        ? this._sourceMap
        : typeof devtool === 'string'
          ? devtool.endsWith('source-map')
          : mode === 'production' && devtool !== false;

    this._optionsForHash.sourceMap = useSourceMaps;
    const binaryConfig: Buffer = Buffer.from(JSON.stringify(this._optionsForHash), 'utf-8');

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation, compilationData) => {
      const { normalModuleFactory } = compilationData;

      function addCommentExtraction(parser: javascript.JavascriptParser): void {
        parser.hooks.program.tap(PLUGIN_NAME, (program: unknown, comments: Comment[]) => {
          const relevantComments: Comment[] = comments.filter(isLicenseComment);
          if (comments.length > 0) {
            // Webpack's typings now restrict the properties on factoryMeta for unknown reasons
            const module: { factoryMeta?: IFactoryMeta } = parser.state.module as unknown as {
              factoryMeta?: IFactoryMeta;
            };
            if (!module.factoryMeta) {
              module.factoryMeta = {
                comments: relevantComments
              };
            } else {
              (module.factoryMeta as IFactoryMeta).comments = relevantComments;
            }
          }
        });
      }

      normalModuleFactory.hooks.parser.for('javascript/auto').tap(PLUGIN_NAME, addCommentExtraction);
      normalModuleFactory.hooks.parser.for('javascript/dynamic').tap(PLUGIN_NAME, addCommentExtraction);
      normalModuleFactory.hooks.parser.for('javascript/esm').tap(PLUGIN_NAME, addCommentExtraction);

      /**
       * Set of local module ids that have been processed.
       */
      const submittedModules: Set<string | number> = new Set();

      /**
       * The text and comments of all minified modules.
       */
      const minifiedModules: IModuleMap = new Map();

      /**
       * The text and comments of all minified chunks. Most of these are trivial, but the runtime chunk is a bit larger.
       */
      const minifiedAssets: IAssetMap = new Map();

      const metadataByModule: WeakMap<Module, IModuleStats> = new WeakMap();
      const metadataByAssetFileName: Map<string, IAssetStats> = new Map();
      const compilationStatistics: IModuleMinifierPluginStats = {
        metadataByModule,
        metadataByAssetFileName
      };
      compilationMetadataMap.set(compilation, compilationStatistics);
      function getOrCreateMetadata(mod: Module): IModuleStats {
        let moduleStats: IModuleStats | undefined = metadataByModule.get(mod);
        if (!moduleStats) {
          moduleStats = {
            hashByChunk: new Map(),
            sizeByHash: new Map()
          };
          metadataByModule.set(mod, moduleStats);
        }
        return moduleStats;
      }

      let pendingMinificationRequests: number = 0;
      /**
       * Indicates that all files have been sent to the minifier and therefore that when pending hits 0, assets can be rehydrated.
       */
      let allRequestsIssued: boolean = false;

      let resolveMinifyPromise: () => void;

      const postProcessCode: (
        code: sources.ReplaceSource,
        context: IPostProcessFragmentContext
      ) => sources.ReplaceSource = (code: sources.ReplaceSource, context: IPostProcessFragmentContext) =>
        this.hooks.postProcessCodeFragment.call(code, context);

      /**
       * Callback to invoke when a file has finished minifying.
       */
      function onFileMinified(): void {
        if (--pendingMinificationRequests === 0 && allRequestsIssued) {
          resolveMinifyPromise();
        }
      }

      const { minifier } = this;

      let minifierConnection: IMinifierConnection | undefined;

      // Typings for this object are not exposed
      // eslint-disable-next-line @typescript-eslint/typedef
      const javascriptHooks = webpack.javascript.JavascriptModulesPlugin.getCompilationHooks(compilation);

      /**
       * The minifier needs to know if the module was wrapped in a factory function, because
       * function (module, exports, require) { // <implementation> }
       * minifies to nothing. Unfortunately we can't tell by inspection if the output was wrapped or not.
       * However, the JavaScriptModulesPlugin invokes three hooks in order when rendering a module:
       * 1) renderModuleContent - Invoked for every module.
       * 2) renderModuleContainer - Invoked when wrapping a module in a factory.
       * 3) renderModulePackage - Invoked for every module as the last hook.
       */
      let nextModule: Module | undefined;
      const sourceCache: WeakMap<sources.Source, ISourceCacheEntry> = new WeakMap();
      javascriptHooks.renderModuleContent.tap(TAP_AFTER, (source) => {
        // Clear the identification state of the current module.
        nextModule = undefined;
        return source;
      });
      javascriptHooks.renderModuleContainer.tap(TAP_AFTER, (source, mod) => {
        // Module is being wrapped in a factory, so it is safe for per-module minification
        // Leave external modules in-place to avoid needing special handling for externals
        if (mod.context !== null || !(mod as ExternalModule).externalType) {
          nextModule = mod;
        }
        return source;
      });
      javascriptHooks.renderModulePackage.tap(
        TAP_AFTER,
        /**
         * Extracts the code for the module and sends it to be minified.
         */
        function minifyModule(
          source: sources.Source,
          mod: Module,
          chunkRenderContext: { chunk: Chunk }
        ): sources.Source {
          if (nextModule !== mod) {
            // This module is being inlined. Abandon per-module minification.
            return source;
          }

          const id: string | number | null = compilation.chunkGraph.getModuleId(mod);

          if (id === null) {
            // This module has no id. Abandon per-module minification.
            return source;
          }

          const metadata: IModuleStats = getOrCreateMetadata(mod);
          const cachedResult: ISourceCacheEntry | undefined = sourceCache.get(source);
          if (cachedResult) {
            metadata.hashByChunk.set(chunkRenderContext.chunk, cachedResult.hash);
            return cachedResult.source;
          }

          // If this module is wrapped in a factory, need to add boilerplate so that the minifier keeps the function
          const wrapped: sources.Source = new ConcatSource(
            MODULE_WRAPPER_PREFIX + '\n',
            source,
            '\n' + MODULE_WRAPPER_SUFFIX
          );

          const nameForMap: string = `(modules)/${id}`;

          const { source: wrappedCodeRaw, map } = useSourceMaps
            ? wrapped.sourceAndMap()
            : {
                source: wrapped.source(),
                map: undefined
              };

          const wrappedCode: string = wrappedCodeRaw.toString();
          const hash: string = hashCodeFragment(wrappedCode);
          metadata.hashByChunk.set(chunkRenderContext.chunk, hash);
          if (!submittedModules.has(hash)) {
            submittedModules.add(hash);

            ++pendingMinificationRequests;

            minifier.minify(
              {
                hash,
                code: wrappedCode,
                nameForMap: useSourceMaps ? nameForMap : undefined,
                externals: undefined
              },
              (result: IModuleMinificationResult) => {
                if (isMinificationResultError(result)) {
                  compilation.errors.push(result.error as WebpackError);
                } else {
                  try {
                    const { code: minified, map: minifierMap } = result;

                    const rawOutput: sources.Source = useSourceMaps
                      ? new SourceMapSource(
                          minified, // Code
                          nameForMap, // File
                          minifierMap!, // Base source map
                          wrappedCode, // Source from before transform
                          map!, // Source Map from before transform
                          true // Remove original source
                        )
                      : new RawSource(minified);

                    const unwrapped: sources.ReplaceSource = new ReplaceSource(rawOutput);
                    const len: number = minified.length;

                    // Trim off the boilerplate used to preserve the factory
                    unwrapped.replace(0, MODULE_WRAPPER_PREFIX.length - 1, '');
                    unwrapped.replace(len - MODULE_WRAPPER_SUFFIX.length, len - 1, '');

                    const withIds: sources.Source = postProcessCode(unwrapped, {
                      compilation,
                      module: mod,
                      loggingName: mod.identifier()
                    });
                    const cached: sources.CachedSource = new CachedSource(withIds);

                    const minifiedSize: number = Buffer.byteLength(cached.source(), 'utf-8');
                    metadata.sizeByHash.set(hash, minifiedSize);

                    minifiedModules.set(hash, {
                      source: cached,
                      module: mod,
                      id
                    });
                  } catch (err) {
                    compilation.errors.push(err);
                  }
                }

                onFileMinified();
              }
            );
          }

          const result: sources.Source = new RawSource(`${CHUNK_MODULE_TOKEN}${hash}`);
          sourceCache.set(source, {
            hash,
            source: result
          });

          // Return an expression to replace later
          return result;
        }
      );

      // The optimizeChunkModules hook is the last async hook that occurs before chunk rendering
      compilation.hooks.optimizeChunkModules.tapPromise(PLUGIN_NAME, async () => {
        minifierConnection = await minifier.connectAsync();

        submittedModules.clear();
      });

      const isJSAsset: RegExp = /\.[cm]?js(\?.+)?$/;

      // This should happen before any other tasks that operate during processAssets
      compilation.hooks.processAssets.tapPromise(TAP_BEFORE, async (): Promise<void> => {
        const { chunkGraph, chunks } = compilation;

        // Still need to minify the rendered assets
        for (const chunk of chunks) {
          const allChunkModules: Iterable<Module> | undefined =
            chunkGraph.getChunkModulesIterableBySourceType(chunk, 'javascript');
          if (!allChunkModules) {
            // This chunk does not contain javascript modules
            continue;
          }

          for (const assetName of chunk.files) {
            const asset: sources.Source = compilation.assets[assetName];

            // Verify that this is a JS asset
            if (isJSAsset.test(assetName)) {
              ++pendingMinificationRequests;

              const { source: wrappedCodeRaw, map } = useSourceMaps
                ? asset.sourceAndMap()
                : {
                    source: asset.source(),
                    map: undefined
                  };

              const rawCode: string = wrappedCodeRaw.toString();
              const nameForMap: string = `(chunks)/${assetName}`;

              const hash: string = hashCodeFragment(rawCode);

              minifier.minify(
                {
                  hash,
                  code: rawCode,
                  nameForMap: useSourceMaps ? nameForMap : undefined,
                  externals: undefined
                },
                (result: IModuleMinificationResult) => {
                  if (isMinificationResultError(result)) {
                    compilation.errors.push(result.error as WebpackError);
                    // eslint-disable-next-line no-console
                    console.error(result.error);
                  } else {
                    try {
                      const { code: minified, map: minifierMap } = result;

                      const rawOutput: sources.Source = useSourceMaps
                        ? new SourceMapSource(
                            minified, // Code
                            nameForMap, // File
                            minifierMap!, // Base source map
                            rawCode, // Source from before transform
                            map, // Source Map from before transform
                            true // Remove original source
                          )
                        : new RawSource(minified);

                      const withIds: sources.Source = postProcessCode(new ReplaceSource(rawOutput), {
                        compilation,
                        module: undefined,
                        loggingName: assetName
                      });

                      minifiedAssets.set(assetName, {
                        source: new CachedSource(withIds),
                        chunk,
                        fileName: assetName,
                        renderInfo: new Map(),
                        type: 'javascript'
                      });
                    } catch (err) {
                      compilation.errors.push(err);
                    }
                  }

                  onFileMinified();
                }
              );
            } else {
              // This isn't a JS asset. Don't try to minify the asset wrapper, though if it contains modules, those might still get replaced with minified versions.
              minifiedAssets.set(assetName, {
                // Still need to restore ids
                source: postProcessCode(new ReplaceSource(asset), {
                  compilation,
                  module: undefined,
                  loggingName: assetName
                }),
                chunk,
                fileName: assetName,
                renderInfo: new Map(),
                type: 'unknown'
              });
            }
          }
        }

        allRequestsIssued = true;

        if (pendingMinificationRequests) {
          await new Promise<void>((resolve) => {
            resolveMinifyPromise = resolve;
          });
        }

        // Handle any error from the minifier.
        await minifierConnection?.disconnectAsync();

        // All assets and modules have been minified, hand them off to be rehydrated
        await this.hooks.rehydrateAssets.promise(
          {
            assets: minifiedAssets,
            modules: minifiedModules
          },
          compilation
        );
      });

      // Need to update chunk hashes with information from this plugin
      javascriptHooks.chunkHash.tap(PLUGIN_NAME, (chunk, hash): void => {
        // Apply the options hash
        hash.update(binaryConfig);
        // Apply the hash from the minifier
        if (minifierConnection) {
          hash.update(minifierConnection.configHash, 'utf8');
        }
      });
    });
  }
}
