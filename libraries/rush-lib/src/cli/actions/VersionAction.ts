// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as semver from 'semver';
import { type IPackageJson, FileConstants, Enum } from '@rushstack/node-core-library';
import type { CommandLineFlagParameter, CommandLineStringParameter } from '@rushstack/ts-command-line';

import { BumpType, type LockStepVersionPolicy } from '../../api/VersionPolicy';
import type { VersionPolicyConfiguration } from '../../api/VersionPolicyConfiguration';
import { RushConfiguration } from '../../api/RushConfiguration';
import { VersionMismatchFinder } from '../../logic/versionMismatch/VersionMismatchFinder';
import type { RushCommandLineParser } from '../RushCommandLineParser';
import * as PolicyValidator from '../../logic/policy/PolicyValidator';
import { BaseRushAction } from './BaseRushAction';
import { PublishGit } from '../../logic/PublishGit';
import { Git } from '../../logic/Git';
import { RushConstants } from '../../logic/RushConstants';

import type * as VersionManagerType from '../../logic/VersionManager';

export const DEFAULT_PACKAGE_UPDATE_MESSAGE: string = 'Bump versions [skip ci]';
export const DEFAULT_CHANGELOG_UPDATE_MESSAGE: string = 'Update changelogs [skip ci]';

export class VersionAction extends BaseRushAction {
  private readonly _ensureVersionPolicy: CommandLineFlagParameter;
  private readonly _overrideVersion: CommandLineStringParameter;
  private readonly _bumpVersion: CommandLineFlagParameter;
  private readonly _versionPolicy: CommandLineStringParameter;
  private readonly _bypassPolicy: CommandLineFlagParameter;
  private readonly _targetBranch: CommandLineStringParameter;
  private readonly _overwriteBump: CommandLineStringParameter;
  private readonly _prereleaseIdentifier: CommandLineStringParameter;
  private readonly _ignoreGitHooksParameter: CommandLineFlagParameter;

  public constructor(parser: RushCommandLineParser) {
    super({
      actionName: 'version',
      summary: 'Manage package versions in the repo.',
      documentation: 'use this "rush version" command to ensure version policies and bump versions.',
      parser
    });

    this._targetBranch = this.defineStringParameter({
      parameterLongName: '--target-branch',
      parameterShortName: '-b',
      argumentName: 'BRANCH',
      description: 'If this flag is specified, changes will be committed and merged into the target branch.'
    });
    this._ensureVersionPolicy = this.defineFlagParameter({
      parameterLongName: '--ensure-version-policy',
      description: 'Updates package versions if needed to satisfy version policies.'
    });
    this._overrideVersion = this.defineStringParameter({
      parameterLongName: '--override-version',
      argumentName: 'NEW_VERSION',
      description:
        'Override the version in the specified --version-policy. ' +
        'This setting only works for lock-step version policy and when --ensure-version-policy is specified.'
    });
    this._bumpVersion = this.defineFlagParameter({
      parameterLongName: '--bump',
      description: 'Bumps package version based on version policies.'
    });
    this._bypassPolicy = this.defineFlagParameter({
      parameterLongName: RushConstants.bypassPolicyFlagLongName,
      description: 'Overrides "gitPolicy" enforcement (use honorably!)'
    });
    this._versionPolicy = this.defineStringParameter({
      parameterLongName: '--version-policy',
      argumentName: 'POLICY',
      description: 'The name of the version policy'
    });
    this._overwriteBump = this.defineStringParameter({
      parameterLongName: '--override-bump',
      argumentName: 'BUMPTYPE',
      description:
        'Overrides the bump type in the version-policy.json for the specified version policy. ' +
        'Valid BUMPTYPE values include: prerelease, prepatch, patch, preminor, minor, premajor and major. ' +
        'This setting only works for lock-step version policy in bump action.'
    });
    this._prereleaseIdentifier = this.defineStringParameter({
      parameterLongName: '--override-prerelease-id',
      argumentName: 'ID',
      description:
        'Overrides the prerelease identifier in the version value of version-policy.json ' +
        'for the specified version policy. ' +
        'This setting only works for lock-step version policy. ' +
        'This setting increases to new prerelease id when "--bump" is provided but only replaces the ' +
        'prerelease name when "--ensure-version-policy" is provided.'
    });
    this._ignoreGitHooksParameter = this.defineFlagParameter({
      parameterLongName: '--ignore-git-hooks',
      description: `Skips execution of all git hooks. Make sure you know what you are skipping.`
    });
  }

  protected async runAsync(): Promise<void> {
    const currentlyInstalledVariant: string | undefined =
      await this.rushConfiguration.getCurrentlyInstalledVariantAsync();
    for (const subspace of this.rushConfiguration.subspaces) {
      await PolicyValidator.validatePolicyAsync(this.rushConfiguration, subspace, currentlyInstalledVariant, {
        bypassPolicyAllowed: true,
        bypassPolicy: this._bypassPolicy.value
      });
    }
    const git: Git = new Git(this.rushConfiguration);
    const userEmail: string = await git.getGitEmailAsync();

    this._validateInput();
    const versionManagerModule: typeof VersionManagerType = await import(
      /* webpackChunkName: 'VersionManager' */
      '../../logic/VersionManager'
    );
    const versionManager: VersionManagerType.VersionManager = new versionManagerModule.VersionManager(
      this.rushConfiguration,
      userEmail,
      this.rushConfiguration.versionPolicyConfiguration
    );

    if (this._ensureVersionPolicy.value) {
      this._overwritePolicyVersionIfNeeded();
      const tempBranch: string = 'version/ensure-' + new Date().getTime();
      versionManager.ensure(
        this._versionPolicy.value,
        true,
        !!this._overrideVersion.value || !!this._prereleaseIdentifier.value
      );

      const updatedPackages: Map<string, IPackageJson> = versionManager.updatedProjects;
      if (updatedPackages.size > 0) {
        // eslint-disable-next-line no-console
        console.log(`${updatedPackages.size} packages are getting updated.`);
        await this._gitProcessAsync(tempBranch, this._targetBranch.value, currentlyInstalledVariant);
      }
    } else if (this._bumpVersion.value) {
      const tempBranch: string = 'version/bump-' + new Date().getTime();
      await versionManager.bumpAsync(
        this._versionPolicy.value,
        this._overwriteBump.value ? Enum.getValueByKey(BumpType, this._overwriteBump.value) : undefined,
        this._prereleaseIdentifier.value,
        true
      );
      await this._gitProcessAsync(tempBranch, this._targetBranch.value, currentlyInstalledVariant);
    }
  }

  private _overwritePolicyVersionIfNeeded(): void {
    if (!this._overrideVersion.value && !this._prereleaseIdentifier.value) {
      // No need to overwrite policy version
      return;
    }
    if (this._overrideVersion.value && this._prereleaseIdentifier.value) {
      throw new Error(
        `The parameters "--override-version" and "--override-prerelease-id" cannot be used together.`
      );
    }

    if (this._versionPolicy.value) {
      const versionConfig: VersionPolicyConfiguration = this.rushConfiguration.versionPolicyConfiguration;
      const policy: LockStepVersionPolicy = versionConfig.getVersionPolicy(
        this._versionPolicy.value
      ) as LockStepVersionPolicy;
      if (!policy || !policy.isLockstepped) {
        throw new Error(`The lockstep version policy "${policy.policyName}" is not found.`);
      }
      let newVersion: string | undefined = undefined;
      if (this._overrideVersion.value) {
        newVersion = this._overrideVersion.value;
      } else if (this._prereleaseIdentifier.value) {
        const newPolicyVersion: semver.SemVer = new semver.SemVer(policy.version);
        if (newPolicyVersion.prerelease.length) {
          // Update 1.5.0-alpha.10 to 1.5.0-beta.10
          // For example, if we are parsing "1.5.0-alpha.10" then the newPolicyVersion.prerelease array
          // would contain [ "alpha", 10 ], so we would replace "alpha" with "beta"
          newPolicyVersion.prerelease = [
            this._prereleaseIdentifier.value,
            ...newPolicyVersion.prerelease.slice(1)
          ];
        } else {
          // Update 1.5.0 to 1.5.0-beta
          // Since there is no length, we can just set to a new array
          newPolicyVersion.prerelease = [this._prereleaseIdentifier.value];
        }
        newVersion = newPolicyVersion.format();
      }

      if (newVersion) {
        versionConfig.update(this._versionPolicy.value, newVersion, true);
      }
    } else {
      throw new Error(
        'Missing --version-policy parameter to specify which version policy should be overwritten.'
      );
    }
  }

  private _validateInput(): void {
    if (this._bumpVersion.value && this._ensureVersionPolicy.value) {
      throw new Error('Please choose --bump or --ensure-version-policy but not together.');
    }

    if (this._overwriteBump.value && !Enum.tryGetValueByKey(BumpType, this._overwriteBump.value)) {
      throw new Error(
        'The value of override-bump is not valid.  ' +
          'Valid values include prerelease, prepatch, patch, preminor, minor, premajor and major'
      );
    }
  }

  private _validateResult(variant: string | undefined): void {
    // Load the config from file to avoid using inconsistent in-memory data.
    const rushConfig: RushConfiguration = RushConfiguration.loadFromConfigurationFile(
      this.rushConfiguration.rushJsonFile
    );

    // Validate result of all subspaces
    for (const subspace of rushConfig.subspaces) {
      // Respect the `ensureConsistentVersions` field in rush.json
      if (!subspace.shouldEnsureConsistentVersions(variant)) {
        continue;
      }

      const mismatchFinder: VersionMismatchFinder = VersionMismatchFinder.getMismatches(rushConfig, {
        subspace,
        variant
      });
      if (mismatchFinder.numberOfMismatches) {
        throw new Error(
          'Unable to finish version bump because inconsistencies were encountered. ' +
            'Run "rush check" to find more details.'
        );
      }
    }
  }

  private async _gitProcessAsync(
    tempBranch: string,
    targetBranch: string | undefined,
    variant: string | undefined
  ): Promise<void> {
    // Validate the result before commit.
    this._validateResult(variant);

    const git: Git = new Git(this.rushConfiguration);
    const publishGit: PublishGit = new PublishGit(git, targetBranch);

    // Make changes in temp branch.
    await publishGit.checkoutAsync(tempBranch, true);

    const uncommittedChanges: ReadonlyArray<string> = await git.getUncommittedChangesAsync();

    // Stage, commit, and push the changes to remote temp branch.
    // Need to commit the change log updates in its own commit
    const changeLogUpdated: boolean = uncommittedChanges.some((changePath) => {
      return changePath.indexOf('CHANGELOG.json') > 0;
    });

    if (changeLogUpdated) {
      await publishGit.addChangesAsync('.', this.rushConfiguration.changesFolder);
      await publishGit.addChangesAsync(':/**/CHANGELOG.json');
      await publishGit.addChangesAsync(':/**/CHANGELOG.md');
      await publishGit.commitAsync(
        this.rushConfiguration.gitChangeLogUpdateCommitMessage || DEFAULT_CHANGELOG_UPDATE_MESSAGE,
        !this._ignoreGitHooksParameter.value
      );
    }

    // Commit the package.json and change files updates.
    const packageJsonUpdated: boolean = uncommittedChanges.some((changePath) => {
      return changePath.indexOf(FileConstants.PackageJson) > 0;
    });

    if (packageJsonUpdated) {
      await publishGit.addChangesAsync(this.rushConfiguration.versionPolicyConfigurationFilePath);
      await publishGit.addChangesAsync(':/**/package.json');
      await publishGit.commitAsync(
        this.rushConfiguration.gitVersionBumpCommitMessage || DEFAULT_PACKAGE_UPDATE_MESSAGE,
        !this._ignoreGitHooksParameter.value
      );
    }

    if (changeLogUpdated || packageJsonUpdated) {
      await publishGit.pushAsync(tempBranch, !this._ignoreGitHooksParameter.value);

      // Now merge to target branch.
      await publishGit.fetchAsync();
      await publishGit.checkoutAsync(targetBranch);
      await publishGit.pullAsync(!this._ignoreGitHooksParameter.value);
      await publishGit.mergeAsync(tempBranch, !this._ignoreGitHooksParameter.value);
      await publishGit.pushAsync(targetBranch, !this._ignoreGitHooksParameter.value);
      await publishGit.deleteBranchAsync(tempBranch, true, !this._ignoreGitHooksParameter.value);
    } else {
      // skip commits
      await publishGit.fetchAsync();
      await publishGit.checkoutAsync(targetBranch);
      await publishGit.deleteBranchAsync(tempBranch, false, !this._ignoreGitHooksParameter.value);
    }
  }
}
