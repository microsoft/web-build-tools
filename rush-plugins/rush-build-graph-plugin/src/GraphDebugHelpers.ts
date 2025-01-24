// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { tryGetOperationId } from './GraphParser';

/* eslint-disable @typescript-eslint/no-explicit-any */

/*
 * Filter Rush's build graph to remove repetitive and unimportant information. Useful if the schema ever changes, or needs to.
 * Due to the fact that it includes all properties that are not banned, it is not guaranteed to be stable across versions.
 * Should not be part of the critical path.
 * @param obj - the object to filter
 * @param depth - the maximum depth to recurse
 * @param simplify - if true, will replace embedded operations with their operation id
 */
export function filterObjectForDebug(obj: Readonly<any>, depth: number = 10, simplify: boolean = false): any {
  const bannedKeys: ReadonlySet<string> = new Set([
    'packageJsonEditor',
    '_packageJson',
    '_subspaces',
    'subspace',
    'rushConfiguration',
    '_rushConfiguration',
    'associatedParameters',
    '_dependencyProjects'
  ]);
  const output: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (bannedKeys.has(key)) {
      output[key] = key + ' truncated';
      continue;
    } else if (typeof value === 'function') {
      output[key] = key + '()';
      continue;
    } else if (value instanceof Set) {
      output[key] = filterObjectForDebug(Array.from(value), Math.min(depth - 1, 5), true);
      continue;
    } else if (value instanceof Object) {
      if (depth <= 0) {
        output[key] = key + ' too deep';
        continue;
      }
      if (simplify) {
        const operationId: string | undefined = tryGetOperationId(value);
        if (operationId) {
          output[key] = operationId;
          continue;
        }
      }
      output[key] = filterObjectForDebug(value, depth - 1);
      continue;
    }
    output[key] = value;
  }
  return output;
}

export function filterObjectForTesting(
  obj: Readonly<any>,
  depth: number = 10,
  ignoreSets: boolean = false
): any {
  const allowedKeys: ReadonlySet<string> = new Set([
    'associatedPhase',
    'name',
    'associatedProject',
    'packageName',
    'projectFolder',
    'dependencies',
    'runner',
    '_commandToRun',
    'isNoOp'
  ]);
  const output: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!allowedKeys.has(key) && !key.match(/^\d+$/)) {
      continue;
    } else if (value instanceof Set) {
      if (!ignoreSets) {
        // Don't need sets inside sets
        output[key] = Array.from(value).map((subValue) =>
          filterObjectForTesting(subValue, Math.min(depth - 1, 5), true)
        );
      }
      continue;
    } else if (value instanceof Object) {
      if (depth <= 0) {
        output[key] = key + ' too deep';
        continue;
      }
      output[key] = filterObjectForTesting(value, depth - 1, ignoreSets);
      continue;
    }
    output[key] = value;
  }
  return output;
}
