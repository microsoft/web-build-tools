// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { Dependency, Module } from 'webpack';

/**
 * Recursively processes module dependencies. If a dependency has blocks, they will be processed too.
 */
export function processModuleDependenciesRecursive(
  module: Module,
  callback: (dependency: Dependency) => void
): void {
  type DependenciesBlock = Pick<Module, 'dependencies' | 'blocks'>;

  const queue: DependenciesBlock[] = [module];
  do {
    const block: DependenciesBlock = queue.pop()!;
    if (block.dependencies) {
      for (const dep of block.dependencies) callback(dep);
    }
    if (block.blocks) {
      for (const b of block.blocks) queue.push(b);
    }
  } while (queue.length !== 0);
}
