// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type {
  Chunk,
  Compilation,
  Compiler,
  Module,
  ModuleGraph,
  WebpackPluginInstance,
  sources
} from 'webpack';

import { Template, dependencies } from 'webpack';

import type { IModuleMinifierPluginHooks } from './ModuleMinifierPlugin.types';
import { STAGE_AFTER } from './Constants';
import { processModuleDependenciesRecursive } from './processModuleDependenciesRecursive';

type ChunkGroup = Compilation['chunkGroups'][0];
type DependencyTemplateContext = Parameters<dependencies.HarmonyImportDependency['getImportStatement']>[1];

interface IAsyncImportMetadata {
  chunkCount: number;
  chunkIds: number[];
  count: number;
  index: number;
}

interface ILocalImportMetadata {
  meta: IAsyncImportMetadata;
  module: Module;
}

interface IConcatenatedModule extends Module {
  modules: Module[];
}

interface IAttributes {
  [x: string]: unknown;
}

interface IImportDependencyTemplate {
  apply(
    dependency: WebpackImportDependency,
    source: sources.ReplaceSource,
    templateContext: DependencyTemplateContext
  ): void;
}

declare class WebpackImportDependency extends dependencies.ModuleDependency {
  public range: [number, number];
  // eslint-disable-next-line @rushstack/no-new-null
  public referencedExports?: string[][] | null;
  public assertions?: IAttributes;
  public get type(): 'import()';
  public get category(): 'esm';
}

const PLUGIN_NAME: 'AsyncImportCompressionPlugin' = 'AsyncImportCompressionPlugin';
const ASYNC_IMPORT_PREFIX: '__IMPORT_ASYNC' = '__IMPORT_ASYNC';
const ASYNC_IMPORT_REGEX: RegExp = /__IMPORT_ASYNC[^\)]+/g;

function getImportTypeExpression(module: Module, originModule: Module, moduleGraph: ModuleGraph): string {
  const strict: boolean = !!originModule.buildMeta?.strictHarmonyModule;
  const exportsType: string | undefined = module.getExportsType(moduleGraph, strict);
  // Logic translated from:
  // https://github.com/webpack/webpack/blob/60daca54105f89eee45e118fd0bbc820730724ee/lib/RuntimeTemplate.js#L566-L586
  switch (exportsType) {
    case 'namespace':
      return '';
    case 'default-with-named':
      return ',3';
    case 'default-only':
      return ',1';
    // case 'dynamic':
    default:
      return ',7';
  }
}

function getImportDependency(compilation: Compilation): typeof WebpackImportDependency {
  for (const constructor of compilation.dependencyFactories.keys()) {
    if (constructor.name === 'ImportDependency') {
      return constructor as typeof WebpackImportDependency;
    }
  }

  throw new Error('ImportDependency not found');
}

export class AsyncImportCompressionPlugin implements WebpackPluginInstance {
  private readonly _minifierHooks: IModuleMinifierPluginHooks;

  public constructor(minifierHooks: IModuleMinifierPluginHooks) {
    this._minifierHooks = minifierHooks;
  }

  public apply(compiler: Compiler): void {
    const asyncImportMap: Map<Module, Map<string, ILocalImportMetadata>> = new Map();
    const asyncImportGroups: Map<string, IAsyncImportMetadata> = new Map();
    let rankedImportGroups: IAsyncImportMetadata[] | undefined;
    const { WebpackError, RuntimeModule, RuntimeGlobals } = compiler.webpack;
    class CompressedAsyncImportRuntimeModule extends RuntimeModule {
      public constructor() {
        super('compressed async import');
      }

      public generate(): string {
        const requireFn: string = RuntimeGlobals.require;
        return Template.asString([
          `var asyncImportChunkGroups = [`,
          rankedImportGroups
            ? rankedImportGroups.map((x) => Template.indent(JSON.stringify(x.chunkIds))).join(',\n')
            : '',
          `];`,
          `${requireFn}.ee = function (groupOrId, moduleId, importType) {`,
          Template.indent([
            `return Promise.all((Array.isArray(groupOrId) ? groupOrId : asyncImportChunkGroups[groupOrId]).map(function (x) { return ${requireFn}.e(x); }))`,
            `.then(importType ? ${requireFn}.t.bind(0,moduleId,importType) : ${requireFn}.bind(0,moduleId));`
          ]),
          `};`
        ]);
      }
    }

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      const { moduleGraph } = compilation;
      asyncImportMap.clear();
      asyncImportGroups.clear();

      this._minifierHooks.postProcessCodeFragment.tap({ name: PLUGIN_NAME, stage: -1 }, (source, context) => {
        const code: string = source.original();

        let localImports: Map<string, ILocalImportMetadata> | undefined;

        // Reset the state of the regex
        ASYNC_IMPORT_REGEX.lastIndex = 0;
        // RegExp.exec uses null or an array as the return type, explicitly
        let match: RegExpExecArray | null = null;
        while ((match = ASYNC_IMPORT_REGEX.exec(code))) {
          const token: string = match[0];

          if (!localImports) {
            if (!context.module) {
              context.compilation.errors.push(
                new WebpackError(
                  `Unexpected async import ${token} in non-module context ${context.loggingName}`
                )
              );
              return source;
            }

            localImports = asyncImportMap.get(context.module);
            if (!localImports) {
              context.compilation.errors.push(
                new WebpackError(`Unexpected async import ${token} in module ${context.loggingName}`)
              );
              return source;
            }
          }

          const localImport: ILocalImportMetadata | undefined = localImports.get(token);
          if (!localImport) {
            context.compilation.errors.push(
              new WebpackError(`Missing metadata for ${token} in module ${context.loggingName}`)
            );
            return source;
          }
          const { meta, module } = localImport;

          const chunkExpression: string = meta.index < 0 ? JSON.stringify(meta.chunkIds) : `${meta.index}`;

          source.replace(
            match.index,
            ASYNC_IMPORT_REGEX.lastIndex - 1,
            `${chunkExpression},${JSON.stringify(module.id!)}${getImportTypeExpression(
              module,
              context.module!,
              moduleGraph
            )}`
          );
        }

        return source;
      });

      compilation.hooks.beforeChunkAssets.tap({ name: PLUGIN_NAME, stage: STAGE_AFTER }, () => {
        const ImportDependency: typeof WebpackImportDependency = getImportDependency(compilation);

        for (const module of compilation.modules) {
          let toProcess: Module[];

          if (isConcatenatedModule(module)) {
            toProcess = module.modules;
          } else {
            toProcess = [module];
          }

          for (const child of toProcess) {
            processModuleDependenciesRecursive(child, (dep) => {
              if (dep instanceof ImportDependency) {
                const targetModule: Module = moduleGraph.getModule(dep);

                if (targetModule) {
                  let localAsyncImports: Map<string, ILocalImportMetadata> | undefined =
                    asyncImportMap.get(module);
                  if (!localAsyncImports) {
                    asyncImportMap.set(module, (localAsyncImports = new Map()));
                  }

                  const chunkGroups: ChunkGroup[] = targetModule.blocks.map((b) =>
                    compilation.chunkGraph.getBlockChunkGroup(b)
                  );

                  const chunkIds: Set<number | string | null> = new Set();

                  for (const chunkGroup of chunkGroups) {
                    for (const chunk of chunkGroup.chunks) {
                      chunkIds.add(chunk.id);
                    }
                  }

                  const idString: string = Array.from(chunkIds).join(';');

                  let meta: IAsyncImportMetadata | undefined = asyncImportGroups.get(idString);
                  if (!meta) {
                    asyncImportGroups.set(
                      idString,
                      (meta = { chunkCount: chunkIds.size, chunkIds: [], count: 0, index: -1 })
                    );
                  }

                  meta.count++;

                  const stringKey: string = `${targetModule.id}`.replace(/[^A-Za-z0-9_$]/g, '_');

                  const key: string = `${ASYNC_IMPORT_PREFIX}${stringKey}`;
                  localAsyncImports.set(key, {
                    meta,
                    module: targetModule
                  });
                }
              }
            });
          }
        }

        const rankedImports: [string, IAsyncImportMetadata][] = [...asyncImportGroups]
          .filter((x) => x[1].count > 1)
          .sort((x, y) => {
            let diff: number = y[1].count - x[1].count;
            if (!diff) {
              diff = y[1].chunkCount - x[1].chunkCount;
            }

            if (!diff) {
              diff = x[0] > y[0] ? 1 : x[0] < y[0] ? -1 : 0;
            }

            return diff;
          });

        for (let i: number = 0, len: number = rankedImports.length; i < len; i++) {
          rankedImports[i][1].index = i;
        }

        rankedImportGroups = rankedImports.map((x) => x[1]);

        const { dependencyTemplates } = compilation;

        const defaultImplementation: IImportDependencyTemplate | undefined =
          dependencyTemplates.get(ImportDependency);

        if (!defaultImplementation) {
          compilation.errors.push(new WebpackError(`Could not find ImportDependencyTemplate`));
        }

        const customTemplate: IImportDependencyTemplate = {
          apply(
            dep: WebpackImportDependency,
            source: sources.ReplaceSource,
            dependencyTemplateContext: DependencyTemplateContext
          ): void {
            const targetModule: Module = moduleGraph.getModule(dep);

            if (targetModule) {
              const moduleId: string | number = compilation.chunkGraph.getModuleId(targetModule);
              const stringKey: string = `${moduleId}`.replace(/[^A-Za-z0-9_$]/g, '_');
              const key: string = `${ASYNC_IMPORT_PREFIX}${stringKey}`;
              const content: string = `__webpack_require__.ee(${key})`;
              source.replace(dep.range[0], dep.range[1] - 1, content);
            } else {
              defaultImplementation?.apply(dep, source, dependencyTemplateContext);
            }
          }
        };

        dependencyTemplates.set(ImportDependency, customTemplate);
      });
    });
  }
}

function isConcatenatedModule(module: Module): module is IConcatenatedModule {
  return module.constructor.name === 'ConcatenatedModule';
}
