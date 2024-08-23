// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { LookupByPath } from '@rushstack/rush-sdk';
import type { IPnpmShrinkwrapDependencyYaml } from '@rushstack/rush-sdk/lib/logic/pnpm/PnpmShrinkwrapFile';
import type {
  ISerializedResolveContext,
  IResolverCacheFile
} from '@rushstack/webpack-workspace-resolve-plugin';

import type { PnpmShrinkwrapFile } from './externals';
import { getDescriptionFileRootFromKey, resolveDependencies, createContextSerializer } from './helpers';
import type { IResolverContext } from './types';

/**
 * The only parts of a RushConfigurationProject needed by this tool.
 * Reduced for unit test typings.
 */
export interface IPartialRushProject {
  projectFolder: string;
  packageJson: {
    name: string;
  };
}

export interface IPlatformInfo {
  os: typeof process.platform;
  cpu: typeof process.arch;
  libc: 'glibc' | 'musl';
}

function isPackageCompatible(
  pack: Pick<IPnpmShrinkwrapDependencyYaml, 'os' | 'cpu' | 'libc'>,
  platformInfo: IPlatformInfo
): boolean {
  if (pack.os?.every((value) => value.toLowerCase() !== platformInfo.os)) {
    return false;
  }
  if (pack.cpu?.every((value) => value.toLowerCase() !== platformInfo.cpu)) {
    return false;
  }
  if (pack.libc?.every((value) => value.toLowerCase() !== platformInfo.libc)) {
    return false;
  }
  return true;
}

/**
 * Options for computing the resolver cache from a lockfile.
 */
export interface IComputeResolverCacheFromLockfileOptions {
  /**
   * The root folder of the workspace being installed
   */
  workspaceRoot: string;
  /**
   * The common root path to trim from the description file roots for brevity
   */
  commonPrefixToTrim: string;
  /**
   * Information about the platform Rush is running on
   */
  platformInfo: IPlatformInfo;
  /**
   * A lookup of projects by their importer path
   */
  projectByImporterPath: Pick<LookupByPath<IPartialRushProject>, 'findChildPath'>;
  /**
   * The lockfile to compute the cache from
   */
  lockfile: PnpmShrinkwrapFile;
  /**
   * A callback to process external packages after they have been enumerated.
   * Broken out as a separate function to facilitate testing without hitting the disk.
   * @remarks This is useful for fetching additional data from the pnpm store
   * @param contexts - The current context information per description file root
   * @param missingOptionalDependencies - The set of optional dependencies that were not installed
   * @returns A promise that resolves when the external packages have been processed
   */
  afterExternalPackagesAsync?: (
    contexts: Map<string, IResolverContext>,
    missingOptionalDependencies: Set<string>
  ) => Promise<void>;
}

/**
 * Given a lockfile and information about the workspace and platform, computes the resolver cache file.
 * @param params - The options for computing the resolver cache
 * @returns A promise that resolves with the resolver cache file
 */
export async function computeResolverCacheFromLockfileAsync(
  params: IComputeResolverCacheFromLockfileOptions
): Promise<IResolverCacheFile> {
  const {
    workspaceRoot,
    commonPrefixToTrim,
    platformInfo,
    projectByImporterPath,
    lockfile,
    afterExternalPackagesAsync
  } = params;
  const contexts: Map<string, IResolverContext> = new Map();
  const missingOptionalDependencies: Set<string> = new Set();

  // Enumerate external dependencies first, to simplify looping over them for store data
  for (const [key, pack] of lockfile.packages) {
    let name: string | undefined = pack.name;
    const descriptionFileRoot: string = getDescriptionFileRootFromKey(workspaceRoot, key, name);

    // Skip optional dependencies that are incompatible with the current environment
    if (pack.optional && !isPackageCompatible(pack, platformInfo)) {
      missingOptionalDependencies.add(descriptionFileRoot);
      continue;
    }

    const integrity: string | undefined = pack.resolution?.integrity;

    if (!name && key.startsWith('/')) {
      const versionIndex: number = key.indexOf('@', 2);
      name = key.slice(1, versionIndex);
    }

    if (!name) {
      throw new Error(`Missing name for ${key}`);
    }

    const context: IResolverContext = {
      descriptionFileRoot,
      descriptionFileHash: integrity,
      isProject: false,
      name,
      deps: new Map(),
      ordinal: contexts.size,
      optional: pack.optional
    };

    contexts.set(descriptionFileRoot, context);

    if (pack.dependencies) {
      resolveDependencies(workspaceRoot, pack.dependencies, context);
    }
    if (pack.optionalDependencies) {
      resolveDependencies(workspaceRoot, pack.optionalDependencies, context);
    }
  }

  if (afterExternalPackagesAsync) {
    await afterExternalPackagesAsync(contexts, missingOptionalDependencies);
  }

  // Add the data for workspace projects
  for (const [importerPath, importer] of lockfile.importers) {
    // Ignore the root project. This plugin assumes you don't have one.
    // A non-empty root project results in global dependency hoisting, and that's bad for strictness.
    if (importerPath === '.') {
      continue;
    }

    const project: IPartialRushProject | undefined = projectByImporterPath.findChildPath(importerPath);
    if (!project) {
      throw new Error(`Missing project for importer ${importerPath}`);
    }

    const context: IResolverContext = {
      descriptionFileRoot: project.projectFolder,
      descriptionFileHash: undefined, // Not needed anymore
      name: project.packageJson.name,
      isProject: true,
      deps: new Map(),
      ordinal: contexts.size
    };

    contexts.set(project.projectFolder, context);

    if (importer.dependencies) {
      resolveDependencies(workspaceRoot, importer.dependencies, context);
    }
    if (importer.devDependencies) {
      resolveDependencies(workspaceRoot, importer.devDependencies, context);
    }
    if (importer.optionalDependencies) {
      resolveDependencies(workspaceRoot, importer.optionalDependencies, context);
    }
  }

  // Convert the intermediate representation to the final cache file
  const serializedContexts: ISerializedResolveContext[] = Array.from(
    contexts,
    createContextSerializer(missingOptionalDependencies, contexts, commonPrefixToTrim)
  );

  const cacheFile: IResolverCacheFile = {
    contexts: serializedContexts
  };

  return cacheFile;
}