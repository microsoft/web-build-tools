// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { FileSystem, JsonFile, JsonSchema, NewlineKind } from '@rushstack/node-core-library';

import type { RushConfiguration } from '../api/RushConfiguration';
import { PnpmShrinkwrapFile } from './pnpm/PnpmShrinkwrapFile';
import type { CommonVersionsConfiguration } from '../api/CommonVersionsConfiguration';
import schemaJson from '../schemas/repo-state.schema.json';
import type { Subspace } from '../api/Subspace';

/**
 * This interface represents the raw repo-state.json file
 * Example:
 *  {
 *    "pnpmShrinkwrapHash": "...",
 *    "preferredVersionsHash": "...",
 *    "packageJsonInjectedDependenciesHash": "..."
 *  }
 */
interface IRepoStateJson {
  /**
   * A hash of the PNPM shrinkwrap file contents
   */
  pnpmShrinkwrapHash?: string;
  /**
   * A hash of the CommonVersionsConfiguration.preferredVersions field
   */
  preferredVersionsHash?: string;
  /**
   * A hash of the injected dependencies in related package.json
   */
  packageJsonInjectedDependenciesHash?: string;
}

/**
 * This file is used to track the state of various Rush-related features. It is generated
 * and updated by Rush.
 *
 * @public
 */
export class RepoStateFile {
  private static _jsonSchema: JsonSchema = JsonSchema.fromLoadedObject(schemaJson);

  private _pnpmShrinkwrapHash: string | undefined;
  private _preferredVersionsHash: string | undefined;
  private _packageJsonInjectedDependenciesHash: string | undefined;
  private _isValid: boolean;
  private _modified: boolean = false;

  /**
   * Get the absolute file path of the repo-state.json file.
   */
  public readonly filePath: string;

  private constructor(repoStateJson: IRepoStateJson | undefined, isValid: boolean, filePath: string) {
    this.filePath = filePath;
    this._isValid = isValid;

    if (repoStateJson) {
      this._pnpmShrinkwrapHash = repoStateJson.pnpmShrinkwrapHash;
      this._preferredVersionsHash = repoStateJson.preferredVersionsHash;
      this._packageJsonInjectedDependenciesHash = repoStateJson.packageJsonInjectedDependenciesHash;
    }
  }

  /**
   * The hash of the pnpm shrinkwrap file at the end of the last update.
   */
  public get pnpmShrinkwrapHash(): string | undefined {
    return this._pnpmShrinkwrapHash;
  }

  /**
   * The hash of all preferred versions at the end of the last update.
   */
  public get preferredVersionsHash(): string | undefined {
    return this._preferredVersionsHash;
  }

  /**
   * The hash of all preferred versions at the end of the last update.
   */
  public get packageJsonInjectedDependenciesHash(): string | undefined {
    return this._packageJsonInjectedDependenciesHash;
  }

  /**
   * If false, the repo-state.json file is not valid and its values cannot be relied upon
   */
  public get isValid(): boolean {
    return this._isValid;
  }

  /**
   * Loads the repo-state.json data from the specified file path.
   * If the file has not been created yet, then an empty object is returned.
   *
   * @param jsonFilename - The path to the repo-state.json file.
   */
  public static loadFromFile(jsonFilename: string): RepoStateFile {
    let fileContents: string | undefined;
    try {
      fileContents = FileSystem.readFile(jsonFilename);
    } catch (error) {
      if (!FileSystem.isNotExistError(error as Error)) {
        throw error;
      }
    }

    let foundMergeConflictMarker: boolean = false;
    let repoStateJson: IRepoStateJson | undefined = undefined;
    if (fileContents) {
      try {
        repoStateJson = JsonFile.parseString(fileContents);
      } catch (error) {
        // Look for a Git merge conflict marker. PNPM gracefully handles merge conflicts in pnpm-lock.yaml,
        // so a user should be able to just run "rush update" if they get conflicts in pnpm-lock.yaml
        // and repo-state.json and have Rush update both.
        for (
          let nextNewlineIndex: number = 0;
          nextNewlineIndex > -1;
          nextNewlineIndex = fileContents.indexOf('\n', nextNewlineIndex + 1)
        ) {
          if (fileContents.substr(nextNewlineIndex + 1, 7) === '<<<<<<<') {
            foundMergeConflictMarker = true;
            repoStateJson = {
              preferredVersionsHash: 'INVALID',
              pnpmShrinkwrapHash: 'INVALID'
            };
            break;
          }
        }
      }

      if (repoStateJson) {
        this._jsonSchema.validateObject(repoStateJson, jsonFilename);
      }
    }

    return new RepoStateFile(repoStateJson, !foundMergeConflictMarker, jsonFilename);
  }

  /**
   * Refresh the data contained in repo-state.json using the current state
   * of the Rush repo, and save the file if changes were made.
   *
   * @param rushConfiguration - The Rush configuration for the repo.
   * @param subspace - The subspace that repo-state.json was loaded from,
   * or `undefined` for the default subspace.
   *
   * @returns true if the file was modified, otherwise false.
   */
  public refreshState(
    rushConfiguration: RushConfiguration,
    subspace: Subspace | undefined,
    variant?: string
  ): boolean {
    if (subspace === undefined) {
      subspace = rushConfiguration.defaultSubspace;
    }

    // Only support saving the pnpm shrinkwrap hash if it was enabled
    const preventShrinkwrapChanges: boolean =
      rushConfiguration.isPnpm &&
      rushConfiguration.pnpmOptions &&
      rushConfiguration.pnpmOptions.preventManualShrinkwrapChanges;
    if (preventShrinkwrapChanges) {
      const pnpmShrinkwrapFile: PnpmShrinkwrapFile | undefined = PnpmShrinkwrapFile.loadFromFile(
        subspace.getCommittedShrinkwrapFilePath(variant)
      );

      if (pnpmShrinkwrapFile) {
        const shrinkwrapFileHash: string = pnpmShrinkwrapFile.getShrinkwrapHash(
          rushConfiguration.experimentsConfiguration.configuration
        );

        if (this._pnpmShrinkwrapHash !== shrinkwrapFileHash) {
          this._pnpmShrinkwrapHash = shrinkwrapFileHash;
          this._modified = true;
        }
      }
    } else if (this._pnpmShrinkwrapHash !== undefined) {
      this._pnpmShrinkwrapHash = undefined;
      this._modified = true;
    }

    // Currently, only support saving the preferred versions hash if using workspaces
    const useWorkspaces: boolean =
      rushConfiguration.pnpmOptions && rushConfiguration.pnpmOptions.useWorkspaces;
    if (useWorkspaces) {
      const commonVersions: CommonVersionsConfiguration = subspace.getCommonVersions(variant);
      const preferredVersionsHash: string = commonVersions.getPreferredVersionsHash();
      if (this._preferredVersionsHash !== preferredVersionsHash) {
        this._preferredVersionsHash = preferredVersionsHash;
        this._modified = true;
      }
    } else if (this._preferredVersionsHash !== undefined) {
      this._preferredVersionsHash = undefined;
      this._modified = true;
    }

    if (rushConfiguration.isPnpm) {
      const packageJsonInjectedDependenciesHash: string | undefined =
        subspace.getPackageJsonInjectedDependenciesHash(variant);

      // packageJsonInjectedDependenciesHash is undefined, means there is no injected dependencies for that subspace
      // so we don't need to track the hash value for that subspace
      if (
        packageJsonInjectedDependenciesHash &&
        packageJsonInjectedDependenciesHash !== this._packageJsonInjectedDependenciesHash
      ) {
        this._packageJsonInjectedDependenciesHash = packageJsonInjectedDependenciesHash;
        this._modified = true;
      } else if (!packageJsonInjectedDependenciesHash && this._packageJsonInjectedDependenciesHash) {
        // if packageJsonInjectedDependenciesHash is undefined, but this._packageJsonInjectedDependenciesHash is not
        // means users may turn off the injected installation
        // so we will need to remove unused fields in repo-state.json as well
        this._packageJsonInjectedDependenciesHash = undefined;
        this._modified = true;
      }
    }

    // Now that the file has been refreshed, we know its contents are valid
    this._isValid = true;

    return this._saveIfModified();
  }

  /**
   * Writes the "repo-state.json" file to disk, using the filename that was passed to loadFromFile().
   */
  private _saveIfModified(): boolean {
    if (this._modified) {
      const content: string =
        '// DO NOT MODIFY THIS FILE MANUALLY BUT DO COMMIT IT. It is generated and used by Rush.' +
        `${NewlineKind.Lf}${this._serialize()}`;
      FileSystem.writeFile(this.filePath, content);
      this._modified = false;
      return true;
    }

    return false;
  }

  private _serialize(): string {
    // We need to set these one-by-one, since JsonFile.stringify does not like undefined values
    const repoStateJson: IRepoStateJson = {};
    if (this._pnpmShrinkwrapHash) {
      repoStateJson.pnpmShrinkwrapHash = this._pnpmShrinkwrapHash;
    }
    if (this._preferredVersionsHash) {
      repoStateJson.preferredVersionsHash = this._preferredVersionsHash;
    }
    if (this._packageJsonInjectedDependenciesHash) {
      repoStateJson.packageJsonInjectedDependenciesHash = this._packageJsonInjectedDependenciesHash;
    }

    return JsonFile.stringify(repoStateJson, { newlineConversion: NewlineKind.Lf });
  }
}
