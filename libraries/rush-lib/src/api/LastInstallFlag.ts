// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { JsonFile, type JsonObject, Path, type IPackageJson } from '@rushstack/node-core-library';
import { pnpmSyncGetJsonVersion } from 'pnpm-sync-lib';
import type { PackageManagerName } from './packageManager/PackageManager';
import type { RushConfiguration } from './RushConfiguration';
import * as objectUtilities from '../utilities/objectUtilities';
import type { Subspace } from './Subspace';
import { Selection } from '../logic/Selection';
import { FlagFile } from './FlagFile';

const LAST_INSTALL_FLAG_FILE_NAME: string = 'last-install';

/**
 * This represents the JSON data structure for the "last-install.flag" file.
 */
export interface ILastInstallFlagJson {
  /**
   * Current node version
   */
  node?: string;
  /**
   * Current package manager name
   */
  packageManager?: PackageManagerName;
  /**
   * Current package manager version
   */
  packageManagerVersion: string;
  /**
   * Current rush json folder
   */
  rushJsonFolder: string;
  /**
   * The content of package.json, used in the flag file of autoinstaller
   */
  packageJson?: IPackageJson;
  /**
   * Same with pnpmOptions.pnpmStorePath in rush.json
   */
  storePath?: string;
  /**
   * Same with pnpmOptions.pnpmVirtualStorePath in rush.json
   */
  virtualStorePath?: string;
  /**
   * An experimental flag used by cleanInstallAfterNpmrcChanges
   */
  npmrcHash?: string;
  /**
   * True when "useWorkspaces" is true in rush.json
   */
  workspaces?: boolean;
  /**
   * True when user explicitly specify "--ignore-scripts" CLI parameter or deferredInstallationScripts
   */
  ignoreScripts?: boolean;
  /**
   * When specified, it is a list of selected projects during partial install
   * It is undefined when full install
   */
  selectedProjectNames?: string[];
  /**
   * pnpm-sync-lib version
   */
  pnpmSync?: string;
}

interface ILockfileValidityCheckOptions {
  statePropertiesToIgnore?: (keyof ILastInstallFlagJson)[];
  rushVerb?: string;
}

/**
 * A helper class for managing last-install flags, which are persistent and
 * indicate that something installed in the folder was successfully completed.
 * It also compares state, so that if something like the Node.js version has changed,
 * it can invalidate the last install.
 */
export class LastInstallFlag extends FlagFile<Partial<ILastInstallFlagJson>> {
  /**
   * Creates a new LastInstall flag
   * @param folderPath - the folder that this flag is managing
   * @param state - optional, the state that should be managed or compared
   */
  public constructor(folderPath: string, state?: Partial<ILastInstallFlagJson>) {
    super(folderPath, LAST_INSTALL_FLAG_FILE_NAME, state || {});
  }

  /**
   * Returns true if the file exists and the contents match the current state.
   */
  public async isValidAsync(): Promise<boolean> {
    return await this._isValidAsync(false, {});
  }

  /**
   * Same as isValid(), but with an additional check:  If the current state is not equal to the previous
   * state, and an the current state causes an error, then throw an exception with a friendly message.
   *
   * @internal
   */
  public async checkValidAndReportStoreIssuesAsync(
    options: ILockfileValidityCheckOptions & { rushVerb: string }
  ): Promise<boolean> {
    return this._isValidAsync(true, options);
  }

  private async _isValidAsync(
    checkValidAndReportStoreIssues: boolean,
    { rushVerb = 'update', statePropertiesToIgnore }: ILockfileValidityCheckOptions = {}
  ): Promise<boolean> {
    let oldState: JsonObject;
    try {
      oldState = await JsonFile.loadAsync(this.path);
    } catch (err) {
      return false;
    }

    const newState: ILastInstallFlagJson = { ...this._state } as ILastInstallFlagJson;
    if (statePropertiesToIgnore) {
      for (const optionToIgnore of statePropertiesToIgnore) {
        delete newState[optionToIgnore];
        delete oldState[optionToIgnore];
      }
    }

    if (!objectUtilities.objectsAreDeepEqual(oldState, newState)) {
      if (checkValidAndReportStoreIssues) {
        const pkgManager: PackageManagerName = newState.packageManager as PackageManagerName;
        if (pkgManager === 'pnpm') {
          if (
            // Only throw an error if the package manager hasn't changed from PNPM
            oldState.packageManager === pkgManager
          ) {
            const normalizedOldStorePath: string = oldState.storePath
              ? Path.convertToPlatformDefault(oldState.storePath)
              : '<global>';
            const normalizedNewStorePath: string = newState.storePath
              ? Path.convertToPlatformDefault(newState.storePath)
              : '<global>';
            if (
              // Throw if the store path changed
              normalizedOldStorePath !== normalizedNewStorePath
            ) {
              throw new Error(
                'Current PNPM store path does not match the last one used. This may cause inconsistency in your builds.\n\n' +
                  `If you wish to install with the new store path, please run "rush ${rushVerb} --purge"\n\n` +
                  `Old Path: ${normalizedOldStorePath}\n` +
                  `New Path: ${normalizedNewStorePath}`
              );
            }
          }
          // check whether new selected projects are installed
          if (newState.selectedProjectNames) {
            if (!oldState.selectedProjectNames) {
              // used to be a full install
              return true;
            } else if (
              Selection.union(newState.selectedProjectNames, oldState.selectedProjectNames).size ===
              oldState.selectedProjectNames.length
            ) {
              // current selected projects are included in old selected projects
              return true;
            }
          }
        }
      }
      return false;
    }

    return true;
  }

  /**
   * Merge new data into current state by "merge"
   */
  public mergeFromObject(data: JsonObject): void {
    if (objectUtilities.isMatch(this._state, data)) {
      return;
    }
    objectUtilities.merge(this._state, data);
  }
}

/**
 * Gets the LastInstall flag and sets the current state. This state is used to compare
 * against the last-known-good state tracked by the LastInstall flag.
 * @param rushConfiguration - the configuration of the Rush repo to get the install
 * state from
 *
 * @internal
 */
export function getCommonTempFlag(
  rushConfiguration: RushConfiguration,
  subspace: Subspace,
  extraState: Record<string, string> = {}
): LastInstallFlag {
  const currentState: ILastInstallFlagJson = {
    node: process.versions.node,
    packageManager: rushConfiguration.packageManager,
    packageManagerVersion: rushConfiguration.packageManagerToolVersion,
    rushJsonFolder: rushConfiguration.rushJsonFolder,
    ignoreScripts: false,
    pnpmSync: pnpmSyncGetJsonVersion(),
    ...extraState
  };

  if (currentState.packageManager === 'pnpm' && rushConfiguration.pnpmOptions) {
    currentState.storePath = rushConfiguration.pnpmOptions.pnpmStorePath;
    currentState.virtualStorePath = rushConfiguration.pnpmOptions.pnpmVirtualStorePath;
    if (rushConfiguration.pnpmOptions.useWorkspaces) {
      currentState.workspaces = rushConfiguration.pnpmOptions.useWorkspaces;
    }
  }

  return new LastInstallFlag(subspace.getSubspaceTempFolderPath(), currentState);
}
