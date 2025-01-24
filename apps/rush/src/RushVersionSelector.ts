// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import * as semver from 'semver';

import { LockFile } from '@rushstack/node-core-library';
import { Utilities } from '@microsoft/rush-lib/lib/utilities/Utilities';
import { _FlagFile, _RushGlobalFolder, type ILaunchOptions } from '@microsoft/rush-lib';

import { RushCommandSelector } from './RushCommandSelector';
import type { MinimalRushConfiguration } from './MinimalRushConfiguration';

const MAX_INSTALL_ATTEMPTS: number = 3;

export class RushVersionSelector {
  private _rushGlobalFolder: _RushGlobalFolder;
  private _currentPackageVersion: string;

  public constructor(currentPackageVersion: string) {
    this._rushGlobalFolder = new _RushGlobalFolder();
    this._currentPackageVersion = currentPackageVersion;
  }

  public async ensureRushVersionInstalledAsync(
    version: string,
    overridePath: string | undefined,
    configuration: MinimalRushConfiguration | undefined,
    executeOptions: ILaunchOptions
  ): Promise<void> {
    const isLegacyRushVersion: boolean = semver.lt(version, '4.0.0');

    let rushPath: string;

    if (overridePath) {
      rushPath = overridePath;
    } else {
      const expectedRushPath: string = path.join(this._rushGlobalFolder.nodeSpecificPath, `rush-${version}`);

      const installMarker: _FlagFile = new _FlagFile(expectedRushPath, 'last-install', {
        node: process.versions.node
      });

      let installIsValid: boolean = await installMarker.isValidAsync();
      if (!installIsValid) {
        // Need to install Rush
        console.log(`Rush version ${version} is not currently installed. Installing...`);

        const resourceName: string = `rush-${version}`;

        console.log(`Trying to acquire lock for ${resourceName}`);

        const lock: LockFile = await LockFile.acquire(expectedRushPath, resourceName);
        installIsValid = await installMarker.isValidAsync();
        if (installIsValid) {
          console.log('Another process performed the installation.');
        } else {
          await Utilities.installPackageInDirectoryAsync({
            directory: expectedRushPath,
            packageName: isLegacyRushVersion ? '@microsoft/rush' : '@microsoft/rush-lib',
            version: version,
            tempPackageTitle: 'rush-local-install',
            maxInstallAttempts: MAX_INSTALL_ATTEMPTS,
            // This is using a local configuration to install a package in a shared global location.
            // Generally that's a bad practice, but in this case if we can successfully install
            // the package at all, we can reasonably assume it's good for all the repositories.
            // In particular, we'll assume that two different NPM registries cannot have two
            // different implementations of the same version of the same package.
            // This was needed for: https://github.com/microsoft/rushstack/issues/691
            commonRushConfigFolder: configuration ? configuration.commonRushConfigFolder : undefined,
            suppressOutput: true
          });

          console.log(`Successfully installed Rush version ${version} in ${expectedRushPath}.`);

          // If we've made it here without exception, write the flag file
          await installMarker.createAsync();

          lock.release();
        }
      }

      if (semver.lt(version, '4.0.0')) {
        rushPath = path.join(expectedRushPath, 'node_modules', '@microsoft', 'rush');
      } else {
        rushPath = path.join(expectedRushPath, 'node_modules', '@microsoft', 'rush-lib');
      }
    }

    if (semver.lt(version, '3.0.20')) {
      // In old versions, requiring the entry point invoked the command-line parser immediately,
      // so fail if "rushx" or "rush-pnpm" was used
      RushCommandSelector.failIfNotInvokedAsRush(version);
      require(path.join(rushPath, 'lib', 'rush'));
    } else if (semver.lt(version, '4.0.0')) {
      // In old versions, requiring the entry point invoked the command-line parser immediately,
      // so fail if "rushx" or "rush-pnpm" was used
      RushCommandSelector.failIfNotInvokedAsRush(version);
      require(path.join(rushPath, 'lib', 'start'));
    } else {
      // For newer rush-lib, RushCommandSelector can test whether "rushx" is supported or not
      const rushCliEntrypoint: {} = require(
        path.join(rushPath, 'lib', 'index')
      );
      RushCommandSelector.execute(this._currentPackageVersion, rushCliEntrypoint, executeOptions);
    }
  }
}
