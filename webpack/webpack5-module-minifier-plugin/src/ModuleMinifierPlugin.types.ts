// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { IModuleMinifier } from '@rushstack/module-minifier';
import type { AsyncSeriesWaterfallHook, SyncWaterfallHook } from 'tapable';
import type { Chunk, Compilation, Module, sources } from 'webpack';
import type { Comment } from 'estree';

/**
 * Information about where the module was rendered in the emitted asset.
 * @public
 */
export interface IRenderedModulePosition {
  /**
   * The offset from the start of tha asset to the start of the module, in characters.
   */
  charOffset: number;
  /**
   * The length of the rendered module, in characters.
   */
  charLength: number;
}

/**
 * Information about a dehydrated webpack ECMAScript asset
 * @public
 */
export interface IAssetInfo {
  /**
   * The (minified) boilerplate code for the asset. Will contain a token to be replaced by the minified modules.
   */
  source: sources.Source;

  /**
   * The name of the asset, used to index into compilation.assets
   */
  fileName: string;

  /**
   * The raw chunk object from Webpack, in case information from it is necessary for reconstruction
   */
  chunk: Chunk;

  /**
   * Information about the offsets and character lengths for each rendered module in the final asset.
   */
  renderInfo: Map<string | number, IRenderedModulePosition>;

  /**
   * The type of the asset
   * @example 'javascript'
   * @example 'css'
   */
  type: string;
}

/**
 * Information about a minified module
 * @public
 */
export interface IModuleInfo {
  /**
   * The (minified) code of this module. Will be a function expression.
   */
  source: sources.Source;

  /**
   * The raw module object from Webpack, in case information from it is necessary for reconstruction
   */
  module: Module;

  /**
   * The id of the module, from the chunk graph.
   */
  id: string | number;
}

/**
 * This is the second parameter to the NormalModuleFactory `module` hook
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export interface _INormalModuleFactoryModuleData {
  resourceResolveData?: {
    /**
     * Contents of the description file (package.json) for the module
     */
    descriptionFileData?: {
      /**
       * The name of the package
       */
      name: string;
    };
    /**
     * Absolute path of the description file (package.json) for the module
     */
    descriptionFilePath?: string;
    /**
     * Absolute path of the directory containing the description file (package.json) for the module
     */
    descriptionFileRoot?: string;
    /**
     * Relative path from the description file (package.json) to the module
     */
    relativePath?: string;
  };
}

/**
 * Properties surfaced via the `factoryMeta` property on webpack modules
 * @public
 */
export interface IFactoryMeta {
  comments?: Comment[];
  skipMinification?: boolean;
}

/**
 * Statistics from the plugin. Namely module sizes.
 * @public
 */
export interface IModuleMinifierPluginStats {
  metadataByModule: WeakMap<Module, IModuleStats>;
  metadataByAssetFileName: Map<string, IAssetStats>;
}

/**
 * Module size data as a function of the target chunk.
 * @public
 */
export interface IModuleStats {
  hashByChunk: Map<Chunk, string>;
  sizeByHash: Map<string, number>;
}

/**
 * Rendered positional data
 * @public
 */
export interface IAssetStats {
  positionByModuleId: Map<string | number, IRenderedModulePosition>;
}

/**
 * A map from file names to dehydrated assets
 * @public
 */
export type IAssetMap = Map<string, IAssetInfo>;
/**
 * A map from module ids to minified modules
 * @public
 */
export type IModuleMap = Map<string | number, IModuleInfo>;

/**
 * Options to the ModuleMinifierPlugin constructor
 * @public
 */
export interface IModuleMinifierPluginOptions {
  /**
   * Minifier implementation to use. Required.
   */
  minifier: IModuleMinifier;

  /**
   * Whether to enable source map processing. If not provided, will attempt to guess based on `mode` and `devtool` in the webpack config.
   * Set to `false` for faster builds at the expense of debuggability.
   */
  sourceMap?: boolean;

  /**
   * Instructs the plugin to alter the code of async import statements to compress better and be portable across compilations.
   */
  compressAsyncImports?: boolean;
}

/**
 * The set of data remaining to rehydrate in the current compilation
 * @public
 */
export interface IDehydratedAssets {
  /**
   * The set of remaining assets to rehydrate. Each tap may remove some or all assets from this collection
   */
  assets: IAssetMap;

  /**
   * The set of modules to use for rehydrating assets.
   */
  modules: IModuleMap;
}

/**
 * Argument to the postProcessCodeFragment hook for the current execution context
 * @public
 */
export interface IPostProcessFragmentContext {
  /**
   * The current webpack compilation, for error reporting
   */
  compilation: Compilation;
  /**
   * A name to use for logging
   */
  loggingName: string;
  /**
   * The current module being processed, or `undefined` if not in a module (e.g. the bootstrapper)
   */
  module: Module | undefined;
}

/**
 * Hooks provided by the ModuleMinifierPlugin
 * @public
 */
export interface IModuleMinifierPluginHooks {
  /**
   * Hook invoked at the start of optimizeChunkAssets to rehydrate the minified boilerplate and runtime into chunk assets.
   */
  rehydrateAssets: AsyncSeriesWaterfallHook<[IDehydratedAssets, Compilation]>;

  /**
   * Hook invoked on code after it has been returned from the minifier.
   */
  postProcessCodeFragment: SyncWaterfallHook<[sources.ReplaceSource, IPostProcessFragmentContext]>;
}
