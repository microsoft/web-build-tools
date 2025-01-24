// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import * as ssri from 'ssri';
import {
  JsonFile,
  Text,
  FileSystem,
  FileConstants,
  Sort,
  InternalError,
  AlreadyReportedError
} from '@rushstack/node-core-library';
import { Colorize, PrintUtilities } from '@rushstack/terminal';

import { BaseInstallManager } from '../base/BaseInstallManager';
import type { IInstallManagerOptions } from '../base/BaseInstallManagerTypes';
import type { BaseShrinkwrapFile } from '../base/BaseShrinkwrapFile';
import type { IRushTempPackageJson } from '../base/BasePackage';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { RushConstants } from '../RushConstants';
import { Stopwatch } from '../../utilities/Stopwatch';
import { Utilities } from '../../utilities/Utilities';
import {
  type PackageJsonEditor,
  DependencyType,
  type PackageJsonDependency
} from '../../api/PackageJsonEditor';
import { DependencySpecifier, DependencySpecifierType } from '../DependencySpecifier';
import { InstallHelpers } from './InstallHelpers';
import { TempProjectHelper } from '../TempProjectHelper';
import type { RushGlobalFolder } from '../../api/RushGlobalFolder';
import type { RushConfiguration } from '../..';
import type { PurgeManager } from '../PurgeManager';
import { LinkManagerFactory } from '../LinkManagerFactory';
import type { BaseLinkManager } from '../base/BaseLinkManager';
import type { PnpmShrinkwrapFile, IPnpmShrinkwrapDependencyYaml } from '../pnpm/PnpmShrinkwrapFile';
import type { Subspace } from '../../api/Subspace';

const globEscape: (unescaped: string) => string = require('glob-escape'); // No @types/glob-escape package exists

/**
 * The "noMtime" flag is new in tar@4.4.1 and not available yet for \@types/tar.
 * As a temporary workaround, augment the type.
 */
declare module 'tar' {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  export interface CreateOptions {
    /**
     * "Set to true to omit writing mtime values for entries. Note that this prevents using other
     * mtime-based features like tar.update or the keepNewer option with the resulting tar archive."
     */
    noMtime?: boolean;
  }
}

/**
 * This class implements common logic between "rush install" and "rush update".
 */
export class RushInstallManager extends BaseInstallManager {
  private _tempProjectHelper: TempProjectHelper;

  public constructor(
    rushConfiguration: RushConfiguration,
    rushGlobalFolder: RushGlobalFolder,
    purgeManager: PurgeManager,
    options: IInstallManagerOptions
  ) {
    super(rushConfiguration, rushGlobalFolder, purgeManager, options);
    this._tempProjectHelper = new TempProjectHelper(
      this.rushConfiguration,
      rushConfiguration.defaultSubspace
    );
  }

  /**
   * Regenerates the common/package.json and all temp_modules projects.
   * If shrinkwrapFile is provided, this function also validates whether it contains
   * everything we need to install and returns true if so; in all other cases,
   * the return value is false.
   *
   * @override
   */
  public async prepareCommonTempAsync(
    subspace: Subspace,
    shrinkwrapFile: BaseShrinkwrapFile | undefined
  ): Promise<{ shrinkwrapIsUpToDate: boolean; shrinkwrapWarnings: string[] }> {
    const stopwatch: Stopwatch = Stopwatch.start();

    const { fullUpgrade, variant } = this.options;

    // Example: "C:\MyRepo\common\temp\projects"
    const tempProjectsFolder: string = path.join(
      this.rushConfiguration.commonTempFolder,
      RushConstants.rushTempProjectsFolderName
    );

    // eslint-disable-next-line no-console
    console.log('\n' + Colorize.bold('Updating temp projects in ' + tempProjectsFolder));

    Utilities.createFolderWithRetry(tempProjectsFolder);

    const shrinkwrapWarnings: string[] = [];

    // We will start with the assumption that it's valid, and then set it to false if
    // any of the checks fail
    let shrinkwrapIsUpToDate: boolean = true;

    if (!shrinkwrapFile) {
      shrinkwrapIsUpToDate = false;
    } else if (shrinkwrapFile.isWorkspaceCompatible && !fullUpgrade) {
      // eslint-disable-next-line no-console
      console.log();
      // eslint-disable-next-line no-console
      console.log(
        Colorize.red(
          'The shrinkwrap file had previously been updated to support workspaces. Run "rush update --full" ' +
            'to update the shrinkwrap file.'
        )
      );
      throw new AlreadyReportedError();
    }

    // dependency name --> version specifier
    const allExplicitPreferredVersions: Map<string, string> = this.rushConfiguration.defaultSubspace
      .getCommonVersions(variant)
      .getAllPreferredVersions();

    if (shrinkwrapFile) {
      // Check any (explicitly) preferred dependencies first
      allExplicitPreferredVersions.forEach((version: string, dependency: string) => {
        const dependencySpecifier: DependencySpecifier = new DependencySpecifier(dependency, version);

        if (!shrinkwrapFile.hasCompatibleTopLevelDependency(dependencySpecifier)) {
          shrinkwrapWarnings.push(
            `Missing dependency "${dependency}" (${version}) required by the preferred versions from ` +
              RushConstants.commonVersionsFilename
          );
          shrinkwrapIsUpToDate = false;
        }
      });

      if (this._findMissingTempProjects(shrinkwrapFile)) {
        // If any Rush project's tarball is missing from the shrinkwrap file, then we need to update
        // the shrinkwrap file.
        shrinkwrapIsUpToDate = false;
      }

      // If there are orphaned projects, we need to update
      const orphanedProjects: ReadonlyArray<string> = shrinkwrapFile.findOrphanedProjects(
        this.rushConfiguration,
        this.rushConfiguration.defaultSubspace
      );

      if (orphanedProjects.length > 0) {
        for (const orphanedProject of orphanedProjects) {
          shrinkwrapWarnings.push(
            `Your ${this.rushConfiguration.shrinkwrapFilePhrase} references "${orphanedProject}" ` +
              `which was not found in ${RushConstants.rushJsonFilename}`
          );
        }
        shrinkwrapIsUpToDate = false;
      }
    }

    // dependency name --> version specifier
    const commonDependencies: Map<string, string> = new Map([
      ...allExplicitPreferredVersions,
      ...this.rushConfiguration.getImplicitlyPreferredVersions(subspace, variant)
    ]);

    // To make the common/package.json file more readable, sort alphabetically
    // according to rushProject.tempProjectName instead of packageName.
    const sortedRushProjects: RushConfigurationProject[] = this.rushConfiguration.projects.slice(0);
    Sort.sortBy(sortedRushProjects, (x) => x.tempProjectName);

    for (const rushProject of sortedRushProjects) {
      const packageJson: PackageJsonEditor = rushProject.packageJsonEditor;

      // Example: "C:\MyRepo\common\temp\projects\my-project-2.tgz"
      const tarballFile: string = this._tempProjectHelper.getTarballFilePath(rushProject);

      // Example: dependencies["@rush-temp/my-project-2"] = "file:./projects/my-project-2.tgz"
      commonDependencies.set(
        rushProject.tempProjectName,
        `file:./${RushConstants.rushTempProjectsFolderName}/${rushProject.unscopedTempProjectName}.tgz`
      );

      const tempPackageJson: IRushTempPackageJson = {
        name: rushProject.tempProjectName,
        version: '0.0.0',
        private: true,
        dependencies: {}
      };

      // Collect pairs of (packageName, packageVersion) to be added as dependencies of the @rush-temp package.json
      const tempDependencies: Map<string, string> = new Map<string, string>();

      // These can be regular, optional, or peer dependencies (but NOT dev dependencies).
      // (A given packageName will never appear more than once in this list.)
      for (const dependency of packageJson.dependencyList) {
        if (this.options.fullUpgrade && this._revertWorkspaceNotation(dependency)) {
          shrinkwrapIsUpToDate = false;
        }

        // If there are any optional dependencies, copy directly into the optionalDependencies field.
        if (dependency.dependencyType === DependencyType.Optional) {
          if (!tempPackageJson.optionalDependencies) {
            tempPackageJson.optionalDependencies = {};
          }
          tempPackageJson.optionalDependencies[dependency.name] = dependency.version;
        } else if (dependency.dependencyType === DependencyType.Peer) {
          if (
            this.rushConfiguration.packageManager !== 'pnpm' ||
            this.rushConfiguration.pnpmOptions.autoInstallPeers === true
          ) {
            tempDependencies.set(dependency.name, dependency.version);
          }
        } else {
          tempDependencies.set(dependency.name, dependency.version);
        }
      }

      for (const dependency of packageJson.devDependencyList) {
        if (this.options.fullUpgrade && this._revertWorkspaceNotation(dependency)) {
          shrinkwrapIsUpToDate = false;
        }

        // If there are devDependencies, we need to merge them with the regular dependencies.  If the same
        // library appears in both places, then the dev dependency wins (because presumably it's saying what you
        // want right now for development, not the range that you support for consumers).
        tempDependencies.set(dependency.name, dependency.version);
      }
      Sort.sortMapKeys(tempDependencies);

      for (const [packageName, packageVersion] of tempDependencies.entries()) {
        const dependencySpecifier: DependencySpecifier = new DependencySpecifier(packageName, packageVersion);

        // Is there a locally built Rush project that could satisfy this dependency?
        // If so, then we will symlink to the project folder rather than to common/temp/node_modules.
        // In this case, we don't want "npm install" to process this package, but we do need
        // to record this decision for linking later, so we add it to a special 'rushDependencies' field.
        const localProject: RushConfigurationProject | undefined =
          this.rushConfiguration.getProjectByName(packageName);

        if (localProject) {
          // Don't locally link if it's listed in the decoupledLocalDependencies
          if (!rushProject.decoupledLocalDependencies.has(packageName)) {
            // Also, don't locally link if the SemVer doesn't match
            const localProjectVersion: string = localProject.packageJsonEditor.version;
            if (semver.satisfies(localProjectVersion, packageVersion)) {
              // We will locally link this package, so instead add it to our special "rushDependencies"
              // field in the package.json file.
              if (!tempPackageJson.rushDependencies) {
                tempPackageJson.rushDependencies = {};
              }
              tempPackageJson.rushDependencies[packageName] = packageVersion;
              continue;
            }
          }
        }

        // We will NOT locally link this package; add it as a regular dependency.
        tempPackageJson.dependencies![packageName] = packageVersion;

        if (
          shrinkwrapFile &&
          !shrinkwrapFile.tryEnsureCompatibleDependency(dependencySpecifier, rushProject.tempProjectName)
        ) {
          shrinkwrapWarnings.push(
            `Missing dependency "${packageName}" (${packageVersion}) required by "${rushProject.packageName}"`
          );
          shrinkwrapIsUpToDate = false;
        }
      }

      if (this.rushConfiguration.packageManager === 'yarn') {
        // This feature is only implemented by the Yarn package manager
        if (packageJson.resolutionsList.length > 0) {
          tempPackageJson.resolutions = packageJson.saveToObject().resolutions;
        }
      }

      // Example: "C:\MyRepo\common\temp\projects\my-project-2"
      const tempProjectFolder: string = this._tempProjectHelper.getTempProjectFolder(rushProject);

      // Example: "C:\MyRepo\common\temp\projects\my-project-2\package.json"
      const tempPackageJsonFilename: string = path.join(tempProjectFolder, FileConstants.PackageJson);

      // we only want to overwrite the package if the existing tarball's package.json is different from tempPackageJson
      let shouldOverwrite: boolean = true;
      try {
        // if the tarball and the temp file still exist, then compare the contents
        if (FileSystem.exists(tarballFile) && FileSystem.exists(tempPackageJsonFilename)) {
          // compare the extracted package.json with the one we are about to write
          const oldBuffer: Buffer = FileSystem.readFileToBuffer(tempPackageJsonFilename);
          const newBuffer: Buffer = Buffer.from(JsonFile.stringify(tempPackageJson));

          if (Buffer.compare(oldBuffer, newBuffer) === 0) {
            shouldOverwrite = false;
          }
        }
      } catch (error) {
        // ignore the error, we will go ahead and create a new tarball
      }

      if (shouldOverwrite) {
        try {
          // ensure the folder we are about to zip exists
          Utilities.createFolderWithRetry(tempProjectFolder);

          // remove the old tarball & old temp package json, this is for any cases where new tarball creation
          // fails, and the shouldOverwrite logic is messed up because the my-project-2\package.json
          // exists and is updated, but the tarball is not accurate
          FileSystem.deleteFile(tarballFile);
          FileSystem.deleteFile(tempPackageJsonFilename);

          // write the expected package.json file into the zip staging folder
          JsonFile.save(tempPackageJson, tempPackageJsonFilename);

          // Delete the existing tarball and create a new one
          this._tempProjectHelper.createTempProjectTarball(rushProject);

          // eslint-disable-next-line no-console
          console.log(`Updating ${tarballFile}`);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.log(Colorize.yellow(error as string));
          // delete everything in case of any error
          FileSystem.deleteFile(tarballFile);
          FileSystem.deleteFile(tempPackageJsonFilename);
        }
      }

      // When using frozen shrinkwrap, we need to validate that the tarball integrities are up-to-date
      // with the shrinkwrap file, since these will cause install to fail.
      if (
        shrinkwrapFile &&
        this.rushConfiguration.isPnpm &&
        this.rushConfiguration.experimentsConfiguration.configuration.usePnpmFrozenLockfileForRushInstall
      ) {
        const pnpmShrinkwrapFile: PnpmShrinkwrapFile = shrinkwrapFile as PnpmShrinkwrapFile;
        const tarballIntegrityValid: boolean = await this._validateRushProjectTarballIntegrityAsync(
          pnpmShrinkwrapFile,
          rushProject
        );
        if (!tarballIntegrityValid) {
          shrinkwrapIsUpToDate = false;
          shrinkwrapWarnings.push(
            `Invalid or missing tarball integrity hash in shrinkwrap for "${rushProject.packageName}"`
          );
        }
      }

      // Save the package.json if we modified the version references and warn that the package.json was modified
      if (packageJson.saveIfModified()) {
        // eslint-disable-next-line no-console
        console.log(
          Colorize.yellow(
            `"${rushProject.packageName}" depends on one or more local packages which used "workspace:" ` +
              'notation. The package.json has been modified and must be committed to source control.'
          )
        );
      }
    }

    // Remove the workspace file if it exists
    if (this.rushConfiguration.isPnpm) {
      const workspaceFilePath: string = path.join(
        this.rushConfiguration.commonTempFolder,
        'pnpm-workspace.yaml'
      );
      try {
        await FileSystem.deleteFileAsync(workspaceFilePath);
      } catch (e) {
        if (!FileSystem.isNotExistError(e as Error)) {
          throw e;
        }
      }
    }

    // Write the common package.json
    InstallHelpers.generateCommonPackageJson(
      this.rushConfiguration,
      this.rushConfiguration.defaultSubspace,
      commonDependencies,
      this._terminal
    );

    stopwatch.stop();
    // eslint-disable-next-line no-console
    console.log(`Finished creating temporary modules (${stopwatch.toString()})`);

    return { shrinkwrapIsUpToDate, shrinkwrapWarnings };
  }

  private _revertWorkspaceNotation(dependency: PackageJsonDependency): boolean {
    const specifier: DependencySpecifier = new DependencySpecifier(dependency.name, dependency.version);
    if (specifier.specifierType !== DependencySpecifierType.Workspace) {
      return false;
    }
    // Replace workspace notation with the supplied version range
    if (specifier.versionSpecifier === '*') {
      // When converting to workspaces, exact package versions are replaced with a '*', so undo this
      const localProject: RushConfigurationProject | undefined = this.rushConfiguration.getProjectByName(
        specifier.packageName
      );
      if (!localProject) {
        throw new InternalError(`Could not find local project with package name ${specifier.packageName}`);
      }
      dependency.setVersion(localProject.packageJson.version);
    } else {
      dependency.setVersion(specifier.versionSpecifier);
    }
    return true;
  }

  private async _validateRushProjectTarballIntegrityAsync(
    shrinkwrapFile: PnpmShrinkwrapFile | undefined,
    rushProject: RushConfigurationProject
  ): Promise<boolean> {
    if (shrinkwrapFile) {
      const tempProjectDependencyKey: string | undefined = shrinkwrapFile.getTempProjectDependencyKey(
        rushProject.tempProjectName
      );
      if (!tempProjectDependencyKey) {
        return false;
      }

      const parentShrinkwrapEntry: IPnpmShrinkwrapDependencyYaml =
        shrinkwrapFile.getShrinkwrapEntryFromTempProjectDependencyKey(tempProjectDependencyKey)!;
      const newIntegrity: string = (
        await ssri.fromStream(fs.createReadStream(this._tempProjectHelper.getTarballFilePath(rushProject)))
      ).toString();

      if (!parentShrinkwrapEntry.resolution || parentShrinkwrapEntry.resolution.integrity !== newIntegrity) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check whether or not the install is already valid, and therefore can be skipped.
   *
   * @override
   */
  protected async canSkipInstallAsync(
    lastModifiedDate: Date,
    subspace: Subspace,
    variant: string | undefined
  ): Promise<boolean> {
    if (!(await super.canSkipInstallAsync(lastModifiedDate, subspace, variant))) {
      return false;
    }

    const potentiallyChangedFiles: string[] = [];

    // Also consider timestamps for all the temp tarballs. (createTempModulesAndCheckShrinkwrap() will
    // carefully preserve these timestamps unless something has changed.)
    // Example: "C:\MyRepo\common\temp\projects\my-project-2.tgz"
    potentiallyChangedFiles.push(
      ...this.rushConfiguration.projects.map((x) => {
        return this._tempProjectHelper.getTarballFilePath(x);
      })
    );

    return Utilities.isFileTimestampCurrentAsync(lastModifiedDate, potentiallyChangedFiles);
  }

  /**
   * Runs "npm/pnpm/yarn install" in the "common/temp" folder.
   *
   * @override
   */
  protected async installAsync(cleanInstall: boolean, subspace: Subspace): Promise<void> {
    // Since we are actually running npm/pnpm/yarn install, recreate all the temp project tarballs.
    // This ensures that any existing tarballs with older header bits will be regenerated.
    // It is safe to assume that temp project pacakge.jsons already exist.
    for (const rushProject of this.rushConfiguration.projects) {
      this._tempProjectHelper.createTempProjectTarball(rushProject);
    }

    // NOTE: The PNPM store is supposed to be transactionally safe, so we don't delete it automatically.
    // The user must request that via the command line.
    if (cleanInstall) {
      if (this.rushConfiguration.packageManager === 'npm') {
        // eslint-disable-next-line no-console
        console.log(`Deleting the "npm-cache" folder`);
        // This is faster and more thorough than "npm cache clean"
        this.installRecycler.moveFolder(this.rushConfiguration.npmCacheFolder);

        // eslint-disable-next-line no-console
        console.log(`Deleting the "npm-tmp" folder`);
        this.installRecycler.moveFolder(this.rushConfiguration.npmTmpFolder);
      }
    }

    // Example: "C:\MyRepo\common\temp\npm-local\node_modules\.bin\npm"
    const packageManagerFilename: string = this.rushConfiguration.packageManagerToolFilename;

    const packageManagerEnv: NodeJS.ProcessEnv = InstallHelpers.getPackageManagerEnvironment(
      this.rushConfiguration,
      this.options
    );

    const commonNodeModulesFolder: string = path.join(
      this.rushConfiguration.commonTempFolder,
      RushConstants.nodeModulesFolderName
    );

    // Is there an existing "node_modules" folder to consider?
    if (FileSystem.exists(commonNodeModulesFolder)) {
      // Should we delete the entire "node_modules" folder?
      if (cleanInstall) {
        // YES: Delete "node_modules"

        // Explain to the user why we are hosing their node_modules folder
        // eslint-disable-next-line no-console
        console.log('Deleting files from ' + commonNodeModulesFolder);

        this.installRecycler.moveFolder(commonNodeModulesFolder);

        Utilities.createFolderWithRetry(commonNodeModulesFolder);
      } else {
        // NO: Prepare to do an incremental install in the "node_modules" folder

        // note: it is not necessary to run "prune" with pnpm
        if (this.rushConfiguration.packageManager === 'npm') {
          // eslint-disable-next-line no-console
          console.log(
            `Running "${this.rushConfiguration.packageManager} prune"` +
              ` in ${this.rushConfiguration.commonTempFolder}`
          );
          const args: string[] = ['prune'];
          this.pushConfigurationArgs(args, this.options, subspace);

          await Utilities.executeCommandWithRetryAsync(
            {
              command: packageManagerFilename,
              args: args,
              workingDirectory: this.rushConfiguration.commonTempFolder,
              environment: packageManagerEnv
            },
            this.options.maxInstallAttempts
          );

          // Delete the (installed image of) the temp projects, since "npm install" does not
          // detect changes for "file:./" references.
          // We recognize the temp projects by their names, which always start with "rush-".

          // Example: "C:\MyRepo\common\temp\node_modules\@rush-temp"
          const pathToDeleteWithoutStar: string = path.join(
            commonNodeModulesFolder,
            RushConstants.rushTempNpmScope
          );
          // eslint-disable-next-line no-console
          console.log(`Deleting ${pathToDeleteWithoutStar}\\*`);
          // Glob can't handle Windows paths
          const normalizedPathToDeleteWithoutStar: string = Text.replaceAll(
            pathToDeleteWithoutStar,
            '\\',
            '/'
          );

          const { default: glob } = await import('fast-glob');
          const tempModulePaths: string[] = await glob(globEscape(normalizedPathToDeleteWithoutStar) + '/*');
          // Example: "C:/MyRepo/common/temp/node_modules/@rush-temp/*"
          for (const tempModulePath of tempModulePaths) {
            // We could potentially use AsyncRecycler here, but in practice these folders tend
            // to be very small
            Utilities.dangerouslyDeletePath(tempModulePath);
          }
        }
      }
    }

    if (this.rushConfiguration.packageManager === 'yarn') {
      // Yarn does not correctly detect changes to a tarball, so we need to forcibly clear its cache
      const yarnRushTempCacheFolder: string = path.join(
        this.rushConfiguration.yarnCacheFolder,
        'v2',
        'npm-@rush-temp'
      );
      if (FileSystem.exists(yarnRushTempCacheFolder)) {
        // eslint-disable-next-line no-console
        console.log('Deleting ' + yarnRushTempCacheFolder);
        Utilities.dangerouslyDeletePath(yarnRushTempCacheFolder);
      }
    }

    // Run "npm install" in the common folder
    const installArgs: string[] = ['install'];
    this.pushConfigurationArgs(installArgs, this.options, subspace);

    // eslint-disable-next-line no-console
    console.log(
      '\n' +
        Colorize.bold(
          `Running "${this.rushConfiguration.packageManager} install" in` +
            ` ${this.rushConfiguration.commonTempFolder}`
        ) +
        '\n'
    );

    // If any diagnostic options were specified, then show the full command-line
    if (this.options.debug || this.options.collectLogFile || this.options.networkConcurrency) {
      // eslint-disable-next-line no-console
      console.log(
        '\n' +
          Colorize.green('Invoking package manager: ') +
          FileSystem.getRealPath(packageManagerFilename) +
          ' ' +
          installArgs.join(' ') +
          '\n'
      );
    }

    await Utilities.executeCommandWithRetryAsync(
      {
        command: packageManagerFilename,
        args: installArgs,
        workingDirectory: this.rushConfiguration.commonTempFolder,
        environment: packageManagerEnv,
        suppressOutput: false
      },
      this.options.maxInstallAttempts,
      () => {
        if (this.rushConfiguration.isPnpm) {
          // eslint-disable-next-line no-console
          console.log(Colorize.yellow(`Deleting the "node_modules" folder`));
          this.installRecycler.moveFolder(commonNodeModulesFolder);

          // Leave the pnpm-store as is for the retry. This ensures that packages that have already
          // been downloaded need not be downloaded again, thereby potentially increasing the chances
          // of a subsequent successful install.

          Utilities.createFolderWithRetry(commonNodeModulesFolder);
        }
      }
    );

    if (this.rushConfiguration.packageManager === 'npm') {
      // eslint-disable-next-line no-console
      console.log('\n' + Colorize.bold('Running "npm shrinkwrap"...'));
      const npmArgs: string[] = ['shrinkwrap'];
      this.pushConfigurationArgs(npmArgs, this.options, subspace);
      await Utilities.executeCommandAsync({
        command: this.rushConfiguration.packageManagerToolFilename,
        args: npmArgs,
        workingDirectory: this.rushConfiguration.commonTempFolder
      });
      // eslint-disable-next-line no-console
      console.log('"npm shrinkwrap" completed\n');

      await this._fixupNpm5RegressionAsync();
    }
  }

  protected async postInstallAsync(subspace: Subspace): Promise<void> {
    if (!this.options.noLink) {
      const linkManager: BaseLinkManager = LinkManagerFactory.getLinkManager(this.rushConfiguration);
      await linkManager.createSymlinksForProjectsAsync(false);
    } else {
      // eslint-disable-next-line no-console
      console.log(
        '\n' + Colorize.yellow('Since "--no-link" was specified, you will need to run "rush link" manually.')
      );
    }
  }

  /**
   * This is a workaround for a bug introduced in NPM 5 (and still unfixed as of NPM 5.5.1):
   * https://github.com/npm/npm/issues/19006
   *
   * The regression is that "npm install" sets the package.json "version" field for the
   * @rush-temp projects to a value like "file:projects/example.tgz", when it should be "0.0.0".
   * This causes linking to fail later, when read-package-tree tries to parse the bad version.
   * The error looks like this:
   *
   * ERROR: Failed to parse package.json for foo: Invalid version: "file:projects/example.tgz"
   *
   * Our workaround is to rewrite the package.json files for each of the @rush-temp projects
   * in the node_modules folder, after "npm install" completes.
   */
  private async _fixupNpm5RegressionAsync(): Promise<void> {
    const pathToDeleteWithoutStar: string = path.join(
      this.rushConfiguration.commonTempFolder,
      'node_modules',
      RushConstants.rushTempNpmScope
    );
    // Glob can't handle Windows paths
    const normalizedPathToDeleteWithoutStar: string = Text.replaceAll(pathToDeleteWithoutStar, '\\', '/');

    let anyChanges: boolean = false;

    const { default: glob } = await import('fast-glob');
    const packageJsonPaths: string[] = await glob(
      globEscape(normalizedPathToDeleteWithoutStar) + '/*/package.json'
    );
    // Example: "C:/MyRepo/common/temp/node_modules/@rush-temp/*/package.json"
    for (const packageJsonPath of packageJsonPaths) {
      // Example: "C:/MyRepo/common/temp/node_modules/@rush-temp/example/package.json"
      const packageJsonObject: IRushTempPackageJson = JsonFile.load(packageJsonPath);

      // The temp projects always use "0.0.0" as their version
      packageJsonObject.version = '0.0.0';

      if (JsonFile.save(packageJsonObject, packageJsonPath, { onlyIfChanged: true })) {
        anyChanges = true;
      }
    }

    if (anyChanges) {
      // eslint-disable-next-line no-console
      console.log(
        '\n' + Colorize.yellow(PrintUtilities.wrapWords(`Applied workaround for NPM 5 bug`)) + '\n'
      );
    }
  }

  /**
   * Checks for temp projects that exist in the shrinkwrap file, but don't exist
   * in rush.json.  This might occur, e.g. if a project was recently deleted or renamed.
   *
   * @returns true if orphans were found, or false if everything is okay
   */
  private _findMissingTempProjects(shrinkwrapFile: BaseShrinkwrapFile): boolean {
    const tempProjectNames: Set<string> = new Set(shrinkwrapFile.getTempProjectNames());

    for (const rushProject of this.rushConfiguration.projects) {
      if (!tempProjectNames.has(rushProject.tempProjectName)) {
        // eslint-disable-next-line no-console
        console.log(
          '\n' +
            Colorize.yellow(
              PrintUtilities.wrapWords(
                `Your ${this.rushConfiguration.shrinkwrapFilePhrase} is missing the project "${rushProject.packageName}".`
              )
            ) +
            '\n'
        );
        return true; // found one
      }
    }

    return false; // none found
  }
}
