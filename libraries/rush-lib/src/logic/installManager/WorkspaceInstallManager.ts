// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import * as semver from 'semver';
import yaml from 'js-yaml';
import {
  FileSystem,
  FileConstants,
  AlreadyReportedError,
  Async,
  type IDependenciesMetaTable,
  Path,
  Sort
} from '@rushstack/node-core-library';
import { createHash } from 'crypto';

import { BaseInstallManager } from '../base/BaseInstallManager';
import type { IInstallManagerOptions } from '../base/BaseInstallManagerTypes';
import type { BaseShrinkwrapFile } from '../base/BaseShrinkwrapFile';
import { DependencySpecifier, DependencySpecifierType } from '../DependencySpecifier';
import {
  type PackageJsonEditor,
  DependencyType,
  type PackageJsonDependencyMeta
} from '../../api/PackageJsonEditor';
import { PnpmWorkspaceFile } from '../pnpm/PnpmWorkspaceFile';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { RushConstants } from '../RushConstants';
import { Utilities } from '../../utilities/Utilities';
import { InstallHelpers } from './InstallHelpers';
import type { CommonVersionsConfiguration } from '../../api/CommonVersionsConfiguration';
import type { RepoStateFile } from '../RepoStateFile';
import { EnvironmentConfiguration } from '../../api/EnvironmentConfiguration';
import { ShrinkwrapFileFactory } from '../ShrinkwrapFileFactory';
import { BaseProjectShrinkwrapFile } from '../base/BaseProjectShrinkwrapFile';
import { type CustomTipId, type ICustomTipInfo, PNPM_CUSTOM_TIPS } from '../../api/CustomTipsConfiguration';
import type { PnpmShrinkwrapFile } from '../pnpm/PnpmShrinkwrapFile';
import { objectsAreDeepEqual } from '../../utilities/objectUtilities';
import type { Subspace } from '../../api/Subspace';
import { Colorize, ConsoleTerminalProvider } from '@rushstack/terminal';
import { BaseLinkManager, SymlinkKind } from '../base/BaseLinkManager';
import { FlagFile } from '../../api/FlagFile';
import { Stopwatch } from '../../utilities/Stopwatch';
import type { PnpmOptionsConfiguration } from '../pnpm/PnpmOptionsConfiguration';

export interface IPnpmModules {
  hoistedDependencies: { [dep in string]: { [depPath in string]: string } };
}

/**
 * This class implements common logic between "rush install" and "rush update".
 */
export class WorkspaceInstallManager extends BaseInstallManager {
  /**
   * @override
   */
  public async doInstallAsync(): Promise<void> {
    // TODO: Remove when "rush link" and "rush unlink" are deprecated
    if (this.options.noLink) {
      // eslint-disable-next-line no-console
      console.log(
        Colorize.red(
          'The "--no-link" option was provided but is not supported when using workspaces. Run the command again ' +
            'without specifying this argument.'
        )
      );
      throw new AlreadyReportedError();
    }

    await super.doInstallAsync();
  }

  /**
   * Regenerates the common/temp/package.json and related workspace files.
   * If shrinkwrapFile is provided, this function also validates whether it contains
   * everything we need to install and returns true if so; in all other cases,
   * the return value is false.
   *
   * @override
   */
  protected async prepareCommonTempAsync(
    subspace: Subspace,
    shrinkwrapFile: (PnpmShrinkwrapFile & BaseShrinkwrapFile) | undefined
  ): Promise<{ shrinkwrapIsUpToDate: boolean; shrinkwrapWarnings: string[] }> {
    // Block use of the RUSH_TEMP_FOLDER environment variable
    if (EnvironmentConfiguration.rushTempFolderOverride !== undefined) {
      throw new Error(
        'The RUSH_TEMP_FOLDER environment variable is not compatible with workspace installs. If attempting ' +
          'to move the PNPM store path or virtual store path, see the `RUSH_PNPM_STORE_PATH` and ' +
          '`RUSH_PNPM_VIRTUAL_STORE_PATH` environment variables, respectively.'
      );
    }

    const { fullUpgrade, allowShrinkwrapUpdates, variant } = this.options;

    // eslint-disable-next-line no-console
    console.log('\n' + Colorize.bold('Updating workspace files in ' + subspace.getSubspaceTempFolderPath()));

    const shrinkwrapWarnings: string[] = [];

    // We will start with the assumption that it's valid, and then set it to false if
    // any of the checks fail
    let shrinkwrapIsUpToDate: boolean = true;

    if (!shrinkwrapFile) {
      shrinkwrapIsUpToDate = false;
    } else {
      if (!shrinkwrapFile.isWorkspaceCompatible && !fullUpgrade) {
        // eslint-disable-next-line no-console
        console.log();
        // eslint-disable-next-line no-console
        console.log(
          Colorize.red(
            'The shrinkwrap file has not been updated to support workspaces. Run "rush update --full" to update ' +
              'the shrinkwrap file.'
          )
        );
        throw new AlreadyReportedError();
      }

      // If there are orphaned projects, we need to update
      const orphanedProjects: ReadonlyArray<string> = shrinkwrapFile.findOrphanedProjects(
        this.rushConfiguration,
        subspace
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

    // If preferred versions have been updated, or if the repo-state.json is invalid,
    // we can't be certain of the state of the shrinkwrap
    const repoState: RepoStateFile = subspace.getRepoState();
    if (!repoState.isValid) {
      shrinkwrapWarnings.push(
        `The ${RushConstants.repoStateFilename} file is invalid. There may be a merge conflict marker in the file.`
      );
      shrinkwrapIsUpToDate = false;
    } else {
      const commonVersions: CommonVersionsConfiguration = subspace.getCommonVersions(variant);
      if (repoState.preferredVersionsHash !== commonVersions.getPreferredVersionsHash()) {
        shrinkwrapWarnings.push(
          `Preferred versions from ${RushConstants.commonVersionsFilename} have been modified.`
        );
        shrinkwrapIsUpToDate = false;
      }

      const stopwatch: Stopwatch = Stopwatch.start();

      const packageJsonInjectedDependenciesHash: string | undefined =
        subspace.getPackageJsonInjectedDependenciesHash(variant);

      stopwatch.stop();

      this._terminal.writeDebugLine(
        `Total amount of time spent to hash related package.json files in the injected installation case: ${stopwatch.toString()}`
      );

      if (packageJsonInjectedDependenciesHash) {
        // if packageJsonInjectedDependenciesHash exists
        // make sure it matches the value in repoState
        if (packageJsonInjectedDependenciesHash !== repoState.packageJsonInjectedDependenciesHash) {
          shrinkwrapWarnings.push(`Some injected dependencies' package.json might have been modified.`);
          shrinkwrapIsUpToDate = false;
        }
      } else {
        // if packageJsonInjectedDependenciesHash not exists
        // there is a situation that the subspace previously has injected dependencies but removed
        // so we can check if the repoState up to date
        if (repoState.packageJsonInjectedDependenciesHash !== undefined) {
          shrinkwrapWarnings.push(
            `It was detected that ${repoState.filePath} contains packageJsonInjectedDependenciesHash` +
              ' but the injected dependencies feature is not enabled. You can manually remove this field in repo-state.json.' +
              ' Or run rush update command to update the repo-state.json file.'
          );
        }
      }
    }

    // To generate the workspace file, we will add each project to the file as we loop through and validate
    const workspaceFile: PnpmWorkspaceFile = new PnpmWorkspaceFile(
      path.join(subspace.getSubspaceTempFolderPath(), 'pnpm-workspace.yaml')
    );

    // For pnpm package manager, we need to handle dependenciesMeta changes in package.json. See more: https://pnpm.io/package_json#dependenciesmeta
    // If dependenciesMeta settings is different between package.json and pnpm-lock.yaml, then shrinkwrapIsUpToDate return false.
    // Build a object for dependenciesMeta settings in projects' package.json
    // key is the package path, value is the dependenciesMeta info for that package
    const expectedDependenciesMetaByProjectRelativePath: Record<string, IDependenciesMetaTable> = {};
    const commonTempFolder: string = subspace.getSubspaceTempFolderPath();
    const rushJsonFolder: string = this.rushConfiguration.rushJsonFolder;
    // get the relative path from common temp folder to repo root folder
    const relativeFromTempFolderToRootFolder: string = path.relative(commonTempFolder, rushJsonFolder);

    // Loop through the projects and add them to the workspace file. While we're at it, also validate that
    // referenced workspace projects are valid, and check if the shrinkwrap file is already up-to-date.
    for (const rushProject of this.rushConfiguration.projects) {
      if (!subspace.contains(rushProject)) {
        // skip processing any project that isn't in this subspace
        continue;
      }
      const packageJson: PackageJsonEditor = rushProject.packageJsonEditor;
      workspaceFile.addPackage(rushProject.projectFolder);

      for (const { name, version, dependencyType } of [
        ...packageJson.dependencyList,
        ...packageJson.devDependencyList
      ]) {
        // Allow the package manager to handle peer dependency resolution, since this is simply a constraint
        // enforced by the package manager. Additionally, peer dependencies are simply a version constraint
        // and do not need to be converted to workspaces protocol.
        if (dependencyType === DependencyType.Peer) {
          continue;
        }

        const dependencySpecifier: DependencySpecifier = new DependencySpecifier(name, version);

        // Is there a locally built Rush project that could satisfy this dependency?
        let referencedLocalProject: RushConfigurationProject | undefined =
          this.rushConfiguration.getProjectByName(name);

        // If we enable exemptDecoupledDependenciesBetweenSubspaces, it will only check dependencies within the subspace.
        if (
          this.rushConfiguration.experimentsConfiguration.configuration
            .exemptDecoupledDependenciesBetweenSubspaces
        ) {
          if (referencedLocalProject && !subspace.contains(referencedLocalProject)) {
            referencedLocalProject = undefined;
          }
        }

        // Validate that local projects are referenced with workspace notation. If not, and it is not a
        // cyclic dependency, then it needs to be updated to specify `workspace:*` explicitly. Currently only
        // supporting versions and version ranges for specifying a local project.
        if (
          (dependencySpecifier.specifierType === DependencySpecifierType.Version ||
            dependencySpecifier.specifierType === DependencySpecifierType.Range) &&
          referencedLocalProject &&
          !rushProject.decoupledLocalDependencies.has(name)
        ) {
          // Make sure that this version is intended to target a local package. If not, then we will fail since it
          // is not explicitly specified as a cyclic dependency.
          if (
            !semver.satisfies(
              referencedLocalProject.packageJsonEditor.version,
              dependencySpecifier.versionSpecifier
            )
          ) {
            // eslint-disable-next-line no-console
            console.log();
            // eslint-disable-next-line no-console
            console.log(
              Colorize.red(
                `"${rushProject.packageName}" depends on package "${name}" (${version}) which belongs to ` +
                  'the workspace but cannot be fulfilled with the specified version range. Either ' +
                  'specify a valid version range, or add the package to "decoupledLocalDependencies" in rush.json.'
              )
            );
            throw new AlreadyReportedError();
          }

          if (!allowShrinkwrapUpdates) {
            // eslint-disable-next-line no-console
            console.log();
            // eslint-disable-next-line no-console
            console.log(
              Colorize.red(
                `"${rushProject.packageName}" depends on package "${name}" (${version}) which exists within ` +
                  'the workspace. Run "rush update" to update workspace references for this package. ' +
                  `If package "${name}" is intentionally expected to be installed from an external package feed, ` +
                  `list package "${name}" in the "decoupledLocalDependencies" field in the ` +
                  `"${rushProject.packageName}" entry in rush.json to suppress this error.`
              )
            );
            throw new AlreadyReportedError();
          }

          if (fullUpgrade) {
            // We will update to `workspace` notation. If the version specified is a range, then use the provided range.
            // Otherwise, use `workspace:*` to ensure we're always using the workspace package.
            const workspaceRange: string =
              !!semver.validRange(dependencySpecifier.versionSpecifier) &&
              !semver.valid(dependencySpecifier.versionSpecifier)
                ? dependencySpecifier.versionSpecifier
                : '*';
            packageJson.addOrUpdateDependency(name, `workspace:${workspaceRange}`, dependencyType);
            shrinkwrapIsUpToDate = false;
            continue;
          }
        } else if (
          dependencySpecifier.specifierType === DependencySpecifierType.Workspace &&
          rushProject.decoupledLocalDependencies.has(name)
        ) {
          // If the dependency is a local project that is decoupled, then we need to ensure that it is not specified
          // as a workspace project. If it is, then we need to update the package.json to remove the workspace notation.
          this._terminal.writeWarningLine(
            `"${rushProject.packageName}" depends on package ${name}@${version}, but also lists it in ` +
              `its "decoupledLocalDependencies" array. Either update the host project's package.json to use ` +
              `a version from an external feed instead of "workspace:" notation, or remove the dependency from the ` +
              `host project's "decoupledLocalDependencies" array in rush.json.`
          );
          throw new AlreadyReportedError();
        } else if (!rushProject.decoupledLocalDependencies.has(name)) {
          // Already specified as a local project. Allow the package manager to validate this
          continue;
        }
      }

      // Save the package.json if we modified the version references and warn that the package.json was modified
      if (packageJson.saveIfModified()) {
        // eslint-disable-next-line no-console
        console.log(
          Colorize.yellow(
            `"${rushProject.packageName}" depends on one or more workspace packages which did not use "workspace:" ` +
              'notation. The package.json has been modified and must be committed to source control.'
          )
        );
      }

      // Now validate that the shrinkwrap file matches what is in the package.json
      if (await shrinkwrapFile?.isWorkspaceProjectModifiedAsync(rushProject, subspace, variant)) {
        shrinkwrapWarnings.push(
          `Dependencies of project "${rushProject.packageName}" do not match the current shrinkwrap.`
        );
        shrinkwrapIsUpToDate = false;
      }

      const dependencyMetaList: ReadonlyArray<PackageJsonDependencyMeta> = packageJson.dependencyMetaList;
      if (dependencyMetaList.length !== 0) {
        const dependenciesMeta: IDependenciesMetaTable = {};
        for (const dependencyMeta of dependencyMetaList) {
          dependenciesMeta[dependencyMeta.name] = {
            injected: dependencyMeta.injected
          };
        }

        // get the relative path from common temp folder to package folder, to align with the value in pnpm-lock.yaml
        const relativePathFromTempFolderToPackageFolder: string = Path.convertToSlashes(
          `${relativeFromTempFolderToRootFolder}/${rushProject.projectRelativeFolder}`
        );
        expectedDependenciesMetaByProjectRelativePath[relativePathFromTempFolderToPackageFolder] =
          dependenciesMeta;
      }
    }

    // Build a object for dependenciesMeta settings in pnpm-lock.yaml
    // key is the package path, value is the dependenciesMeta info for that package
    const lockfileDependenciesMetaByProjectRelativePath: { [key: string]: IDependenciesMetaTable } = {};
    if (shrinkwrapFile?.importers !== undefined) {
      for (const [key, value] of shrinkwrapFile?.importers) {
        const projectRelativePath: string = Path.convertToSlashes(key);

        // we only need to verify packages that exist in package.json and pnpm-lock.yaml
        // PNPM won't actively remove deleted packages in importers, unless it has to
        // so it is possible that a deleted package still showing in pnpm-lock.yaml
        if (expectedDependenciesMetaByProjectRelativePath[projectRelativePath] === undefined) {
          continue;
        }
        if (value.dependenciesMeta !== undefined) {
          lockfileDependenciesMetaByProjectRelativePath[projectRelativePath] = value.dependenciesMeta;
        }
      }
    }

    // Now, we compare these two objects to see if they are equal or not
    const dependenciesMetaAreEqual: boolean = objectsAreDeepEqual(
      expectedDependenciesMetaByProjectRelativePath,
      lockfileDependenciesMetaByProjectRelativePath
    );

    if (!dependenciesMetaAreEqual) {
      shrinkwrapWarnings.push(
        "The dependenciesMeta settings in one or more package.json don't match the current shrinkwrap."
      );
      shrinkwrapIsUpToDate = false;
    }

    // Check if overrides and globalOverrides are the same
    const pnpmOptions: PnpmOptionsConfiguration =
      subspace.getPnpmOptions() || this.rushConfiguration.pnpmOptions;

    const overridesAreEqual: boolean = objectsAreDeepEqual<Record<string, string>>(
      pnpmOptions.globalOverrides ?? {},
      shrinkwrapFile?.overrides ? Object.fromEntries(shrinkwrapFile?.overrides) : {}
    );

    if (!overridesAreEqual) {
      shrinkwrapWarnings.push("The overrides settings doesn't match the current shrinkwrap.");
      shrinkwrapIsUpToDate = false;
    }

    // Check if packageExtensionsChecksum matches globalPackageExtension's hash
    const packageExtensionsChecksum: string | undefined = this._getPackageExtensionChecksum(
      pnpmOptions.globalPackageExtensions
    );
    const packageExtensionsChecksumAreEqual: boolean =
      packageExtensionsChecksum === shrinkwrapFile?.packageExtensionsChecksum;

    if (!packageExtensionsChecksumAreEqual) {
      shrinkwrapWarnings.push("The package extension hash doesn't match the current shrinkwrap.");
      shrinkwrapIsUpToDate = false;
    }

    // Write the common package.json
    InstallHelpers.generateCommonPackageJson(this.rushConfiguration, subspace, undefined, this._terminal);

    // Save the generated workspace file. Don't update the file timestamp unless the content has changed,
    // since "rush install" will consider this timestamp
    workspaceFile.save(workspaceFile.workspaceFilename, { onlyIfChanged: true });

    return { shrinkwrapIsUpToDate, shrinkwrapWarnings };
  }

  private _getPackageExtensionChecksum(
    packageExtensions: Record<string, unknown> | undefined
  ): string | undefined {
    // https://github.com/pnpm/pnpm/blob/ba9409ffcef0c36dc1b167d770a023c87444822d/pkg-manager/core/src/install/index.ts#L331
    const packageExtensionsChecksum: string | undefined =
      Object.keys(packageExtensions ?? {}).length === 0
        ? undefined
        : createObjectChecksum(packageExtensions!);

    return packageExtensionsChecksum;
  }

  protected async canSkipInstallAsync(
    lastModifiedDate: Date,
    subspace: Subspace,
    variant: string | undefined
  ): Promise<boolean> {
    if (!(await super.canSkipInstallAsync(lastModifiedDate, subspace, variant))) {
      return false;
    }

    const potentiallyChangedFiles: string[] = [];

    if (this.rushConfiguration.isPnpm) {
      // Add workspace file. This file is only modified when workspace packages change.
      const pnpmWorkspaceFilename: string = path.join(
        subspace.getSubspaceTempFolderPath(),
        'pnpm-workspace.yaml'
      );

      if (FileSystem.exists(pnpmWorkspaceFilename)) {
        potentiallyChangedFiles.push(pnpmWorkspaceFilename);
      }
    }

    // Also consider timestamps for all the project node_modules folders, as well as the package.json
    // files
    // Example: [ "C:\MyRepo\projects\projectA\node_modules", "C:\MyRepo\projects\projectA\package.json" ]
    potentiallyChangedFiles.push(
      ...subspace.getProjects().map((project) => {
        return path.join(project.projectFolder, RushConstants.nodeModulesFolderName);
      }),
      ...subspace.getProjects().map((project) => {
        return path.join(project.projectFolder, FileConstants.PackageJson);
      })
    );

    // NOTE: If any of the potentiallyChangedFiles does not exist, then isFileTimestampCurrent()
    // returns false.
    return Utilities.isFileTimestampCurrentAsync(lastModifiedDate, potentiallyChangedFiles);
  }

  /**
   * Runs "pnpm install" in the common folder.
   */
  protected async installAsync(cleanInstall: boolean, subspace: Subspace): Promise<void> {
    // Example: "C:\MyRepo\common\temp\npm-local\node_modules\.bin\npm"
    const packageManagerFilename: string = this.rushConfiguration.packageManagerToolFilename;

    const packageManagerEnv: NodeJS.ProcessEnv = InstallHelpers.getPackageManagerEnvironment(
      this.rushConfiguration,
      this.options
    );
    if (ConsoleTerminalProvider.supportsColor) {
      packageManagerEnv.FORCE_COLOR = '1';
    }

    const commonNodeModulesFolder: string = path.join(
      subspace.getSubspaceTempFolderPath(),
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
      }
    }

    const doInstallInternalAsync = async (options: IInstallManagerOptions): Promise<void> => {
      // Run "npm install" in the common folder
      // To ensure that the output is always colored, set the option "--color=always", even when it's piped.
      // Without this argument, certain text that should be colored (such as red) will appear white.
      const installArgs: string[] = ['install'];
      this.pushConfigurationArgs(installArgs, options, subspace);

      // eslint-disable-next-line no-console
      console.log(
        '\n' +
          Colorize.bold(
            `Running "${this.rushConfiguration.packageManager} install" in` +
              ` ${subspace.getSubspaceTempFolderPath()}`
          ) +
          '\n'
      );

      // If any diagnostic options were specified, then show the full command-line
      if (
        this.options.debug ||
        this.options.collectLogFile ||
        this.options.networkConcurrency ||
        this.options.onlyShrinkwrap
      ) {
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

      // Store the tip IDs that should be printed.
      // They will be printed all at once *after* the install
      const tipIDsToBePrinted: Set<CustomTipId> = new Set();
      const pnpmTips: ICustomTipInfo[] = [];
      for (const [customTipId, customTip] of Object.entries(PNPM_CUSTOM_TIPS)) {
        if (
          this.rushConfiguration.customTipsConfiguration.providedCustomTipsByTipId.has(
            customTipId as CustomTipId
          )
        ) {
          pnpmTips.push(customTip);
        }
      }

      const onPnpmStdoutChunk: ((chunk: string) => void) | undefined =
        pnpmTips.length > 0
          ? (chunk: string): void => {
              // Iterate over the supported custom tip metadata and try to match the chunk.
              for (const { isMatch, tipId } of pnpmTips) {
                if (isMatch?.(chunk)) {
                  tipIDsToBePrinted.add(tipId);
                }
              }
            }
          : undefined;
      try {
        await Utilities.executeCommandWithRetryAsync(
          {
            command: packageManagerFilename,
            args: installArgs,
            workingDirectory: subspace.getSubspaceTempFolderPath(),
            environment: packageManagerEnv,
            suppressOutput: false,
            onStdoutStreamChunk: onPnpmStdoutChunk
          },
          this.options.maxInstallAttempts,
          () => {
            if (this.rushConfiguration.isPnpm) {
              this._terminal.writeWarningLine(`Deleting the "node_modules" folder`);
              this.installRecycler.moveFolder(commonNodeModulesFolder);

              // Leave the pnpm-store as is for the retry. This ensures that packages that have already
              // been downloaded need not be downloaded again, thereby potentially increasing the chances
              // of a subsequent successful install.

              Utilities.createFolderWithRetry(commonNodeModulesFolder);
            }
          }
        );
      } finally {
        // The try-finally is to avoid the tips NOT being printed if the install fails.
        // NOT catching the error because we want to keep the other behaviors (i.e., the error will be caught and handle in upper layers).

        if (tipIDsToBePrinted.size > 0) {
          this._terminal.writeLine();
          for (const tipID of tipIDsToBePrinted) {
            this.rushConfiguration.customTipsConfiguration._showTip(this._terminal, tipID);
          }
        }
      }
    };

    const { configuration: experiments } = this.rushConfiguration.experimentsConfiguration;
    if (
      this.options.allowShrinkwrapUpdates &&
      experiments.usePnpmLockfileOnlyThenFrozenLockfileForRushUpdate
    ) {
      await doInstallInternalAsync({
        ...this.options,
        onlyShrinkwrap: true
      });

      await doInstallInternalAsync({
        ...this.options,
        allowShrinkwrapUpdates: false
      });
    } else {
      await doInstallInternalAsync(this.options);
    }

    // If all attempts fail we just terminate. No special handling needed.

    // Ensure that node_modules folders exist after install, since the timestamps on these folders are used
    // to determine if the install can be skipped
    const projectNodeModulesFolders: string[] = [
      path.join(subspace.getSubspaceTempFolderPath(), RushConstants.nodeModulesFolderName),
      ...this.rushConfiguration.projects.map((project) => {
        return path.join(project.projectFolder, RushConstants.nodeModulesFolderName);
      })
    ];

    for (const nodeModulesFolder of projectNodeModulesFolders) {
      FileSystem.ensureFolder(nodeModulesFolder);
    }

    // eslint-disable-next-line no-console
    console.log('');
  }

  protected async postInstallAsync(subspace: Subspace): Promise<void> {
    // Grab the temp shrinkwrap, as this was the most recently completed install. It may also be
    // more up-to-date than the checked-in shrinkwrap since filtered installs are not written back.
    // Note that if there are no projects, or if we're in PNPM workspace mode and there are no
    // projects with dependencies, a lockfile won't be generated.
    const tempShrinkwrapFile: BaseShrinkwrapFile | undefined = ShrinkwrapFileFactory.getShrinkwrapFile(
      this.rushConfiguration.packageManager,
      subspace.getTempShrinkwrapFilename()
    );

    if (tempShrinkwrapFile) {
      // Write or delete all project shrinkwraps related to the install
      await Async.forEachAsync(
        subspace.getProjects(),
        async (project) => {
          await tempShrinkwrapFile.getProjectShrinkwrap(project)?.updateProjectShrinkwrapAsync();
        },
        { concurrency: 10 }
      );
    } else if (this.rushConfiguration.isPnpm && this.rushConfiguration.pnpmOptions?.useWorkspaces) {
      // If we're in PNPM workspace mode and PNPM didn't create a shrinkwrap file,
      // there are no dependencies. Generate empty shrinkwrap files for all projects.
      await Async.forEachAsync(
        subspace.getProjects(),
        async (project) => {
          await BaseProjectShrinkwrapFile.saveEmptyProjectShrinkwrapFileAsync(project);
        },
        { concurrency: 10 }
      );
    } else {
      // This is an unexpected case
      throw new Error(
        'A shrinkwrap file does not exist after after successful installation. This probably indicates a ' +
          'bug in the package manager.'
      );
    }

    // If the splitWorkspaceCompatibility is enabled for subspaces, create symlinks to mimic the behaviour
    // of having the node_modules folder created directly in the project folder. This requires symlinking two categories:
    // 1) Symlink any packages that are declared to be publicly hoisted, such as by using public-hoist-pattern in .npmrc.
    //    This creates a symlink from <project_folder>/node_modules/<dependency> -> temp/<subspace_name>/node_modules/<dependency>
    // 2) Symlink any workspace packages that are declared in the temp folder, as some packages may expect these packages to exist
    //    in the node_modules folder.
    //    This creates a symlink from temp/<subspace_name>/node_modules/<workspace_dependency_name> -> <workspace_dependency_folder>
    if (
      this.rushConfiguration.subspacesFeatureEnabled &&
      this.rushConfiguration.subspacesConfiguration?.splitWorkspaceCompatibility
    ) {
      const tempNodeModulesPath: string = `${subspace.getSubspaceTempFolderPath()}/node_modules`;
      const modulesFilePath: string = `${tempNodeModulesPath}/${RushConstants.pnpmModulesFilename}`;
      if (
        subspace.subspaceName.startsWith('split_') &&
        subspace.getProjects().length === 1 &&
        (await FileSystem.existsAsync(modulesFilePath))
      ) {
        // Find the .modules.yaml file in the subspace temp/node_modules folder
        const modulesContent: string = await FileSystem.readFileAsync(modulesFilePath);
        const yamlContent: IPnpmModules = yaml.load(modulesContent, { filename: modulesFilePath });
        const { hoistedDependencies } = yamlContent;
        const subspaceProject: RushConfigurationProject = subspace.getProjects()[0];
        const projectNodeModulesPath: string = `${subspaceProject.projectFolder}/node_modules`;
        for (const value of Object.values(hoistedDependencies)) {
          for (const [filePath, type] of Object.entries(value)) {
            if (type === 'public') {
              if (Utilities.existsOrIsSymlink(`${projectNodeModulesPath}/${filePath}`)) {
                await FileSystem.deleteFolderAsync(`${projectNodeModulesPath}/${filePath}`);
              }
              // If we don't already have a symlink for this package, create one
              const parentDir: string = Utilities.trimAfterLastSlash(`${projectNodeModulesPath}/${filePath}`);
              await FileSystem.ensureFolderAsync(parentDir);
              BaseLinkManager._createSymlink({
                linkTargetPath: `${tempNodeModulesPath}/${filePath}`,
                newLinkPath: `${projectNodeModulesPath}/${filePath}`,
                symlinkKind: SymlinkKind.Directory
              });
            }
          }
        }
      }

      // Look for any workspace linked packages anywhere in this subspace, symlink them from the temp node_modules folder.
      const subspaceDependencyProjects: Set<RushConfigurationProject> = new Set();
      for (const subspaceProject of subspace.getProjects()) {
        for (const dependencyProject of subspaceProject.dependencyProjects) {
          subspaceDependencyProjects.add(dependencyProject);
        }
      }
      for (const dependencyProject of subspaceDependencyProjects) {
        const symlinkToCreate: string = `${tempNodeModulesPath}/${dependencyProject.packageName}`;
        if (!Utilities.existsOrIsSymlink(symlinkToCreate)) {
          const parentFolder: string = Utilities.trimAfterLastSlash(symlinkToCreate);
          await FileSystem.ensureFolderAsync(parentFolder);
          BaseLinkManager._createSymlink({
            linkTargetPath: dependencyProject.projectFolder,
            newLinkPath: symlinkToCreate,
            symlinkKind: SymlinkKind.Directory
          });
        }
      }
    }
    // TODO: Remove when "rush link" and "rush unlink" are deprecated
    await new FlagFile(
      subspace.getSubspaceTempFolderPath(),
      RushConstants.lastLinkFlagFilename,
      {}
    ).createAsync();
  }

  /**
   * Used when invoking the NPM tool.  Appends the common configuration options
   * to the command-line.
   */
  protected pushConfigurationArgs(args: string[], options: IInstallManagerOptions, subspace: Subspace): void {
    super.pushConfigurationArgs(args, options, subspace);

    // Add workspace-specific args
    if (this.rushConfiguration.isPnpm) {
      args.push('--recursive');
      args.push('--link-workspace-packages', 'false');

      if (process.stdout.isTTY) {
        // If we're on a TTY console and something else didn't set a `--reporter` parameter,
        // explicitly set the default reporter. This fixes an issue where, when the pnpm
        // output is being monitored to match custom tips, pnpm will detect a non-TTY
        // stdout stream and use the `append-only` reporter.
        //
        // See docs here: https://pnpm.io/cli/install#--reportername
        let includesReporterArg: boolean = false;
        for (const arg of args) {
          if (arg.startsWith('--reporter')) {
            includesReporterArg = true;
            break;
          }
        }

        if (!includesReporterArg) {
          args.push('--reporter', 'default');
        }
      }

      for (const arg of this.options.pnpmFilterArgumentValues) {
        args.push('--filter', arg);
      }
    }
  }
}

/**
 * Source: https://github.com/pnpm/pnpm/blob/ba9409ffcef0c36dc1b167d770a023c87444822d/pkg-manager/core/src/install/index.ts#L821-L824
 * @param obj
 * @returns
 */
function createObjectChecksum(obj: Record<string, unknown>): string {
  const s: string = JSON.stringify(Sort.sortKeys(obj));
  return createHash('md5').update(s).digest('hex');
}
