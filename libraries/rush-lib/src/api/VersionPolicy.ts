// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as semver from 'semver';
import { type IPackageJson, Enum } from '@rushstack/node-core-library';

import {
  type IVersionPolicyJson,
  type ILockStepVersionJson,
  type IIndividualVersionJson,
  VersionFormatForCommit,
  VersionFormatForPublish,
  type IVersionPolicyDependencyJson
} from './VersionPolicyConfiguration';
import type { PackageJsonEditor } from './PackageJsonEditor';
import type { RushConfiguration } from './RushConfiguration';
import type { RushConfigurationProject } from './RushConfigurationProject';
import { cloneDeep } from '../utilities/objectUtilities';

/**
 * Type of version bumps
 * @public
 *
 * @internalRemarks
 * This is a copy of the semver ReleaseType enum, but with the `none` value added and
 * the `premajor` and `prepatch` omitted.
 * See {@link LockStepVersionPolicy._getReleaseType}.
 */
export enum BumpType {
  // No version bump
  'none' = 0,
  // Prerelease version bump
  'prerelease' = 1,
  // Patch version bump
  'patch' = 2,
  // Preminor version bump
  'preminor' = 3,
  // Minor version bump
  'minor' = 4,
  // Major version bump
  'major' = 5,
  // Premajor version bump
  'premajor' = 6,
  // Prepatch version bump
  'prepatch' = 7
}

/**
 * Version policy base type names
 * @public
 */
export enum VersionPolicyDefinitionName {
  'lockStepVersion',
  'individualVersion'
}

/**
 * This is the base class for version policy which controls how versions get bumped.
 * @public
 */
export abstract class VersionPolicy {
  private _versionFormatForCommit: VersionFormatForCommit;
  private _versionFormatForPublish: VersionFormatForPublish;

  /**
   * Version policy name
   */
  public readonly policyName: string;

  /**
   * Version policy definition name
   */
  public readonly definitionName: VersionPolicyDefinitionName;

  /**
   * Determines if a version policy wants to opt out of changelog files.
   */
  public readonly exemptFromRushChange: boolean;

  /**
   * Determines if a version policy wants to opt in to including email.
   */
  public readonly includeEmailInChangeFile: boolean;

  /**
   * @internal
   */
  public constructor(versionPolicyJson: IVersionPolicyJson) {
    this.policyName = versionPolicyJson.policyName;
    this.definitionName = Enum.getValueByKey(VersionPolicyDefinitionName, versionPolicyJson.definitionName);
    this.exemptFromRushChange = versionPolicyJson.exemptFromRushChange || false;
    this.includeEmailInChangeFile = versionPolicyJson.includeEmailInChangeFile || false;

    const jsonDependencies: IVersionPolicyDependencyJson = versionPolicyJson.dependencies || {};
    this._versionFormatForCommit = jsonDependencies.versionFormatForCommit || VersionFormatForCommit.original;
    this._versionFormatForPublish =
      jsonDependencies.versionFormatForPublish || VersionFormatForPublish.original;
  }

  /**
   * Loads from version policy json
   *
   * @param versionPolicyJson - version policy Json
   *
   * @internal
   */
  public static load(versionPolicyJson: IVersionPolicyJson): VersionPolicy | undefined {
    const definition: VersionPolicyDefinitionName = Enum.getValueByKey(
      VersionPolicyDefinitionName,
      versionPolicyJson.definitionName
    );
    if (definition === VersionPolicyDefinitionName.lockStepVersion) {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      return new LockStepVersionPolicy(versionPolicyJson as ILockStepVersionJson);
    } else if (definition === VersionPolicyDefinitionName.individualVersion) {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      return new IndividualVersionPolicy(versionPolicyJson as IIndividualVersionJson);
    }
    return undefined;
  }

  /**
   * Whether it is a lockstepped version policy
   */
  public get isLockstepped(): boolean {
    return this.definitionName === VersionPolicyDefinitionName.lockStepVersion;
  }

  /**
   * Returns an updated package json that satisfies the policy.
   *
   * @param project - package json
   * @param force - force update even when the project version is higher than the policy version.
   */
  public abstract ensure(project: IPackageJson, force?: boolean): IPackageJson | undefined;

  /**
   * Bumps version based on the policy
   *
   * @param bumpType - (optional) override bump type
   * @param identifier - (optional) override prerelease Id
   */
  public abstract bump(bumpType?: BumpType, identifier?: string): void;

  /**
   * Serialized json for the policy
   *
   * @internal
   */
  public abstract get _json(): IVersionPolicyJson;

  /**
   * Validates the specified version and throws if the version does not satisfy the policy.
   *
   * @param versionString - version string
   * @param packageName - package name
   */
  public abstract validate(versionString: string, packageName: string): void;

  /**
   * Tells the version policy to modify any dependencies in the target package
   * to values used for publishing.
   */
  public setDependenciesBeforePublish(packageName: string, configuration: RushConfiguration): void {
    if (this._versionFormatForPublish === VersionFormatForPublish.exact) {
      const project: RushConfigurationProject = configuration.getProjectByName(packageName)!;

      const packageJsonEditor: PackageJsonEditor = project.packageJsonEditor;

      for (const dependency of packageJsonEditor.dependencyList) {
        const rushDependencyProject: RushConfigurationProject | undefined = configuration.getProjectByName(
          dependency.name
        );

        if (rushDependencyProject) {
          const dependencyVersion: string = rushDependencyProject.packageJson.version;

          dependency.setVersion(dependencyVersion);
        }
      }

      packageJsonEditor.saveIfModified();
    }
  }

  /**
   * Tells the version policy to modify any dependencies in the target package
   * to values used for checked-in source.
   */
  public setDependenciesBeforeCommit(packageName: string, configuration: RushConfiguration): void {
    if (this._versionFormatForCommit === VersionFormatForCommit.wildcard) {
      const project: RushConfigurationProject = configuration.getProjectByName(packageName)!;

      const packageJsonEditor: PackageJsonEditor = project.packageJsonEditor;

      for (const dependency of packageJsonEditor.dependencyList) {
        const rushDependencyProject: RushConfigurationProject | undefined = configuration.getProjectByName(
          dependency.name
        );

        if (rushDependencyProject) {
          dependency.setVersion('*');
        }
      }

      packageJsonEditor.saveIfModified();
    }
  }
}

/**
 * This policy indicates all related projects should use the same version.
 * @public
 */
export class LockStepVersionPolicy extends VersionPolicy {
  private _version: semver.SemVer;

  /**
   * The type of bump for next bump.
   */
  // nextBump is probably not needed. It can be prerelease only.
  // Other types of bumps can be passed in as a parameter to bump method, so can identifier.
  public readonly nextBump: BumpType | undefined;

  /**
   * The main project for the version policy.
   *
   * If the value is provided, change logs will only be generated in that project.
   * If the value is not provided, change logs will be hosted in each project associated with the policy.
   */
  public readonly mainProject: string | undefined;

  /**
   * @internal
   */
  public constructor(versionPolicyJson: ILockStepVersionJson) {
    super(versionPolicyJson);
    this._version = new semver.SemVer(versionPolicyJson.version);
    this.nextBump =
      versionPolicyJson.nextBump !== undefined
        ? Enum.getValueByKey(BumpType, versionPolicyJson.nextBump)
        : undefined;
    this.mainProject = versionPolicyJson.mainProject;
  }

  /**
   * The value of the lockstep version
   */
  public get version(): string {
    return this._version.format();
  }

  /**
   * Serialized json for this policy
   *
   * @internal
   */
  public get _json(): ILockStepVersionJson {
    const json: ILockStepVersionJson = {
      policyName: this.policyName,
      definitionName: VersionPolicyDefinitionName[this.definitionName],
      version: this.version
    };
    if (this.nextBump !== undefined) {
      json.nextBump = BumpType[this.nextBump];
    }
    if (this.mainProject !== undefined) {
      json.mainProject = this.mainProject;
    }
    return json;
  }

  /**
   * Returns an updated package json that satisfies the version policy.
   *
   * @param project - input package json
   * @param force - force update even when the project version is higher than the policy version.
   */
  public ensure(project: IPackageJson, force?: boolean): IPackageJson | undefined {
    const packageVersion: semver.SemVer = new semver.SemVer(project.version);
    const compareResult: number = packageVersion.compare(this._version);
    if (compareResult === 0) {
      return undefined;
    } else if (compareResult > 0 && !force) {
      const errorMessage: string =
        `Version ${project.version} in package ${project.name}` +
        ` is higher than locked version ${this._version.format()}.`;
      throw new Error(errorMessage);
    }
    return this._updatePackageVersion(project, this._version);
  }

  /**
   * Bumps the version of the lockstep policy
   *
   * @param bumpType - Overwrite bump type in version-policy.json with the provided value.
   * @param identifier - Prerelease identifier if bump type is prerelease.
   */
  public bump(bumpType?: BumpType, identifier?: string): void {
    const nextBump: BumpType | undefined = bumpType ?? this.nextBump;

    if (nextBump === undefined) {
      // let change files drive version bump.
      return;
    }

    this._version.inc(this._getReleaseType(nextBump), identifier);
  }

  /**
   * Updates the version of the policy directly with a new value
   * @param newVersionString - New version
   */
  public update(newVersionString: string): boolean {
    const newVersion: semver.SemVer = new semver.SemVer(newVersionString);
    if (!newVersion || this._version === newVersion) {
      return false;
    }
    this._version = newVersion;
    return true;
  }

  /**
   * Validates the specified version and throws if the version does not satisfy lockstep version.
   *
   * @param versionString - version string
   * @param packageName - package name
   */
  public validate(versionString: string, packageName: string): void {
    const versionToTest: semver.SemVer = new semver.SemVer(versionString, false);
    if (this._version.compare(versionToTest) !== 0) {
      throw new Error(`Invalid version ${versionString} in ${packageName}`);
    }
  }

  private _updatePackageVersion(project: IPackageJson, newVersion: semver.SemVer): IPackageJson {
    const updatedProject: IPackageJson = cloneDeep(project);
    updatedProject.version = newVersion.format();
    return updatedProject;
  }

  private _getReleaseType(bumpType: BumpType): semver.ReleaseType {
    // Eventually we should just use ReleaseType and get rid of bump type.
    return BumpType[bumpType] as semver.ReleaseType;
  }
}

/**
 * This policy indicates all related projects get version bump driven by their own changes.
 * @public
 */
export class IndividualVersionPolicy extends VersionPolicy {
  /**
   * The major version that has been locked
   */
  public readonly lockedMajor: number | undefined;

  /**
   * @internal
   */
  public constructor(versionPolicyJson: IIndividualVersionJson) {
    super(versionPolicyJson);
    this.lockedMajor = versionPolicyJson.lockedMajor;
  }

  /**
   * Serialized json for this policy
   *
   * @internal
   */
  public get _json(): IIndividualVersionJson {
    const json: IIndividualVersionJson = {
      policyName: this.policyName,
      definitionName: VersionPolicyDefinitionName[this.definitionName]
    };
    if (this.lockedMajor !== undefined) {
      json.lockedMajor = this.lockedMajor;
    }
    return json;
  }

  /**
   * Returns an updated package json that satisfies the version policy.
   *
   * @param project - input package json
   * @param force - force update even when the project version is higher than the policy version.
   */
  public ensure(project: IPackageJson, force?: boolean): IPackageJson | undefined {
    if (this.lockedMajor) {
      const version: semver.SemVer = new semver.SemVer(project.version);
      if (version.major < this.lockedMajor) {
        const updatedProject: IPackageJson = cloneDeep(project);
        updatedProject.version = `${this.lockedMajor}.0.0`;
        return updatedProject;
      } else if (version.major > this.lockedMajor) {
        const errorMessage: string =
          `Version ${project.version} in package ${project.name}` +
          ` is higher than locked major version ${this.lockedMajor}.`;
        throw new Error(errorMessage);
      }
    }
    return undefined;
  }

  /**
   * Bumps version.
   * Individual version policy lets change files drive version bump. This method currently does not do anything.
   *
   * @param bumpType - bump type
   * @param identifier - prerelease id
   */
  public bump(bumpType?: BumpType, identifier?: string): void {
    // individual version policy lets change files drive version bump.
  }

  /**
   * Validates the specified version and throws if the version does not satisfy the policy.
   *
   * @param versionString - version string
   * @param packageName - package name
   */
  public validate(versionString: string, packageName: string): void {
    const versionToTest: semver.SemVer = new semver.SemVer(versionString, false);
    if (this.lockedMajor !== undefined) {
      if (this.lockedMajor !== versionToTest.major) {
        throw new Error(`Invalid major version ${versionString} in ${packageName}`);
      }
    }
  }
}
