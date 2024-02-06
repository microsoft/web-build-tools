// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { default as webpack, Compilation, Chunk, Asset, sources } from 'webpack';
import { Text } from '@rushstack/node-core-library';

import type { ILocalizedWebpackChunk } from './webpackInterfaces';

interface IHashReplacement {
  existingHash: string;
  trueHashByLocale: string | Record<string, string> | undefined;
}

export type HashFn = (contents: string | Buffer) => string;

export interface IGetHashFunctionOptions {
  thisWebpack: typeof webpack;
  compilation: Compilation;
}

export function getHashFunction({ thisWebpack, compilation }: IGetHashFunctionOptions): HashFn {
  const { hashFunction = 'md5', hashDigest = 'hex', hashDigestLength } = compilation.outputOptions;
  return (contents: string | Buffer) =>
    thisWebpack.util
      .createHash(hashFunction)
      .update(contents)
      .digest(hashDigest)
      .toString()
      .slice(0, hashDigestLength);
}

export interface IUpdateAssetHashesOptions {
  thisWebpack: typeof webpack;
  compilation: Compilation;
  hashFn: HashFn;
  filesByChunkName?: Map<string, Record<string, string>>;
}

interface IProcessChunkAssetResult {
  trueHash: string;
  newJsFilename: string;
}

export function updateAssetHashes({
  thisWebpack,
  compilation,
  hashFn,
  filesByChunkName
}: IUpdateAssetHashesOptions): void {
  const unprocessedDependenciesByChunk: Map<Chunk, Set<Chunk>> = new Map();
  const dependenciesByChunk: Map<Chunk, Set<Chunk>> = new Map();
  const dependentsByChunk: Map<Chunk, Set<Chunk>> = new Map();
  for (const chunk of compilation.chunks) {
    let unprocessedDependencies: Set<Chunk> | undefined = unprocessedDependenciesByChunk.get(chunk);
    if (!unprocessedDependencies) {
      unprocessedDependencies = new Set();
      unprocessedDependenciesByChunk.set(chunk, unprocessedDependencies);
    }

    let dependencies: Set<Chunk> | undefined = dependenciesByChunk.get(chunk);
    if (!dependencies) {
      dependencies = new Set();
      dependenciesByChunk.set(chunk, dependencies);
    }

    if (chunk.hasRuntime()) {
      for (const asyncChunk of chunk.getAllAsyncChunks()) {
        unprocessedDependencies.add(asyncChunk);
        dependencies.add(asyncChunk);

        let dependents: Set<Chunk> | undefined = dependentsByChunk.get(asyncChunk);
        if (!dependents) {
          dependents = new Set();
          dependentsByChunk.set(asyncChunk, dependents);
        }

        dependents.add(chunk);
      }
    }
  }

  const hashReplacementsByChunk: Map<Chunk, IHashReplacement> = new Map();
  const unprocessedChunks: Set<Chunk> = new Set(compilation.chunks);
  let previousSize: number = -1;
  while (unprocessedChunks.size > 0) {
    const currentSize: number = unprocessedChunks.size;
    if (currentSize === previousSize) {
      compilation.errors.push(
        new thisWebpack.WebpackError(
          `Detected a cycle in the chunk dependencies. This should not be possible.`
        )
      );

      break;
    }

    previousSize = currentSize;

    for (const chunk of unprocessedChunks) {
      if (unprocessedDependenciesByChunk.get(chunk)?.size === 0) {
        // TODO: do we need to check if the chunk is rendered?
        if (!chunk.renderedHash) {
          compilation.errors.push(
            new thisWebpack.WebpackError(`Could not find the hash for chunk ${chunk.id}.`)
          );
        } else {
          const existingHash: string = chunk.contentHash.javascript;
          const chunkDependencies: Set<Chunk> | undefined = dependenciesByChunk.get(chunk);
          if (!chunkDependencies) {
            compilation.errors.push(
              new thisWebpack.WebpackError(`Could not find dependencies for chunk ${chunk.id}.`)
            );
          } else {
            function processChunkAsset(
              jsAssetName: string,
              locale: string | undefined
            ): IProcessChunkAssetResult | undefined {
              const asset: Readonly<Asset> | undefined = compilation.getAsset(jsAssetName);
              if (!asset) {
                compilation.errors.push(
                  new thisWebpack.WebpackError(`Could not find asset "${jsAssetName}" for chunk ${chunk.id}.`)
                );
              } else {
                let assetSource: sources.Source = asset.source;
                const assetName: string = asset.name;
                if (chunkDependencies!.size > 0) {
                  const relevantHashReplacements: Map<string, string> = new Map();
                  let hasAnyReplacements: boolean = false;
                  for (const dependency of chunkDependencies!) {
                    const asyncChunkHashReplacements: IHashReplacement | undefined =
                      hashReplacementsByChunk.get(dependency);
                    if (!asyncChunkHashReplacements) {
                      compilation.errors.push(
                        new thisWebpack.WebpackError(
                          `Could not find hash replacements for chunk ${dependency.id}.`
                        )
                      );
                    } else {
                      const { existingHash: otherChunkExistingHash, trueHashByLocale } =
                        asyncChunkHashReplacements;
                      let replacementHash: string | undefined;
                      if (typeof trueHashByLocale === 'object') {
                        if (locale) {
                          replacementHash = trueHashByLocale[locale];
                        }
                      } else {
                        replacementHash = trueHashByLocale;
                      }

                      if (replacementHash) {
                        if (relevantHashReplacements.has(otherChunkExistingHash)) {
                          compilation.errors.push(
                            new thisWebpack.WebpackError(
                              `Found multiple replacements for hash ${otherChunkExistingHash} ` +
                                `in chunk ${chunk.id}.`
                            )
                          );
                        } else {
                          relevantHashReplacements.set(otherChunkExistingHash, replacementHash);
                          hasAnyReplacements = true;
                        }
                      }
                    }
                  }

                  if (hasAnyReplacements) {
                    const sourceString: string = assetSource.source().toString();
                    const replaceSource: sources.ReplaceSource = new thisWebpack.sources.ReplaceSource(
                      assetSource,
                      assetName
                    );

                    const regexp: RegExp = new RegExp(
                      Array.from(relevantHashReplacements.keys())
                        .map((hashToReplace) => Text.escapeRegExp(hashToReplace))
                        .join('|'),
                      'g'
                    );
                    let match: RegExpMatchArray | null;
                    while ((match = regexp.exec(sourceString)) !== null) {
                      const { 0: originalHash, index } = match;
                      const matchStart: number = index!;
                      const matchEnd: number = matchStart + originalHash.length - 1;
                      const replacement: string = relevantHashReplacements.get(originalHash)!;
                      replaceSource.replace(matchStart, matchEnd, replacement);
                    }

                    assetSource = replaceSource;
                    compilation.updateAsset(jsAssetName, assetSource);
                  }
                }

                if (jsAssetName.includes(existingHash)) {
                  const trueHash: string = hashFn(assetSource.buffer());
                  if (trueHash !== existingHash) {
                    const newJsFilename: string = jsAssetName.replace(existingHash, trueHash);
                    compilation.renameAsset(jsAssetName, newJsFilename);

                    if (locale) {
                      const filesForChunkName: Record<string, string> | undefined = filesByChunkName?.get(
                        chunk.name
                      );
                      if (filesForChunkName) {
                        filesForChunkName[locale] = newJsFilename;
                      }
                    }

                    return {
                      trueHash,
                      newJsFilename
                    };
                  }
                }
              }
            }

            const localizedFiles: Record<string, string> | undefined = (chunk as ILocalizedWebpackChunk)
              .localizedFiles;
            if (localizedFiles) {
              const trueHashByLocale: Record<string, string> = {};
              hashReplacementsByChunk.set(chunk, {
                existingHash,
                trueHashByLocale
              });
              for (const [locale, jsAssetName] of Object.entries(localizedFiles)) {
                const processAssetResult: IProcessChunkAssetResult | undefined = processChunkAsset(
                  jsAssetName,
                  locale
                );
                if (processAssetResult) {
                  const { trueHash, newJsFilename } = processAssetResult;
                  trueHashByLocale[locale] = trueHash;
                  localizedFiles[locale] = newJsFilename;
                }
              }
            } else {
              const assetNames: string[] = Array.from(chunk.files);
              let jsAssetName: string | undefined;
              for (const assetName of assetNames) {
                if (assetName.endsWith('.js')) {
                  if (jsAssetName) {
                    compilation.errors.push(
                      new thisWebpack.WebpackError(`Found multiple .js assets for chunk ${chunk.id}.`)
                    );
                  } else {
                    jsAssetName = assetName;
                  }
                }
              }

              if (!jsAssetName) {
                compilation.errors.push(
                  new thisWebpack.WebpackError(`Could not find a .js asset for chunk ${chunk.id}.`)
                );
              } else {
                const { trueHash, newJsFilename } = processChunkAsset(jsAssetName, undefined) ?? {};
                hashReplacementsByChunk.set(chunk, { existingHash, trueHashByLocale: trueHash });
                if (newJsFilename) {
                  chunk.files.delete(jsAssetName);
                  chunk.files.add(newJsFilename);
                }
              }
            }
          }

          unprocessedChunks.delete(chunk);
          const dependents: Set<Chunk> | undefined = dependentsByChunk.get(chunk);
          if (dependents) {
            for (const dependent of dependents) {
              unprocessedDependenciesByChunk.get(dependent)?.delete(chunk);
            }
          }
        }
      }
    }
  }
}