// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { JsonFile, type JsonObject } from '@rushstack/node-core-library';
import { NonProjectConfigurationFile } from '@rushstack/heft-config-file';
import { ConsoleTerminalProvider, Terminal } from '@rushstack/terminal';

import {
  type IPackageManagerOptionsJsonBase,
  PackageManagerOptionsConfigurationBase
} from '../base/BasePackageManagerOptionsConfiguration';
import { EnvironmentConfiguration } from '../../api/EnvironmentConfiguration';
import schemaJson from '../../schemas/pnpm-config.schema.json';

/**
 * This represents the available PNPM store options
 * @public
 */
export type PnpmStoreLocation = 'local' | 'global';

/**
 * @deprecated Use {@link PnpmStoreLocation} instead
 * @public
 */
export type PnpmStoreOptions = PnpmStoreLocation;

/**
 * Possible values for the `resolutionMode` setting in Rush's pnpm-config.json file.
 * @remarks
 * These modes correspond to PNPM's `resolution-mode` values, which are documented here:
 * {@link https://pnpm.io/npmrc#resolution-mode}
 *
 * @public
 */
export type PnpmResolutionMode = 'highest' | 'time-based' | 'lowest-direct';

/**
 * Possible values for the `pnpmLockfilePolicies` setting in Rush's pnpm-config.json file.
 * @public
 */
export interface IPnpmLockfilePolicies {
  /**
   * Forbid sha1 hashes in `pnpm-lock.yaml`
   */
  disallowInsecureSha1?: {
    enabled: boolean;
    exemptPackageVersions: Record<string, string[]>;
  };
}

/**
 * @public
 */
export interface IPnpmPeerDependencyRules {
  ignoreMissing?: string[];
  allowAny?: string[];
  allowedVersions?: Record<string, string>;
}

/**
 * @public
 */
export interface IPnpmPeerDependenciesMeta {
  [packageName: string]: {
    optional?: boolean;
  };
}

/**
 * @public
 */
export interface IPnpmPackageExtension {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: IPnpmPeerDependenciesMeta;
}

/**
 * Part of IRushConfigurationJson.
 * @internal
 */
export interface IPnpmOptionsJson extends IPackageManagerOptionsJsonBase {
  /**
   * {@inheritDoc PnpmOptionsConfiguration.pnpmStore}
   */
  pnpmStore?: PnpmStoreLocation;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.strictPeerDependencies}
   */
  strictPeerDependencies?: boolean;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.preventManualShrinkwrapChanges}
   */
  preventManualShrinkwrapChanges?: boolean;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.useWorkspaces}
   */
  useWorkspaces?: boolean;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.globalOverrides}
   */
  globalOverrides?: Record<string, string>;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.globalPeerDependencyRules}
   */
  globalPeerDependencyRules?: IPnpmPeerDependencyRules;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.globalPackageExtensions}
   */
  globalPackageExtensions?: Record<string, IPnpmPackageExtension>;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.globalNeverBuiltDependencies}
   */
  globalNeverBuiltDependencies?: string[];
  /**
   * {@inheritDoc PnpmOptionsConfiguration.globalIgnoredOptionalDependencies}
   */
  globalIgnoredOptionalDependencies?: string[];
  /**
   * {@inheritDoc PnpmOptionsConfiguration.globalAllowedDeprecatedVersions}
   */
  globalAllowedDeprecatedVersions?: Record<string, string>;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.globalPatchedDependencies}
   */
  globalPatchedDependencies?: Record<string, string>;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.unsupportedPackageJsonSettings}
   */
  unsupportedPackageJsonSettings?: unknown;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.resolutionMode}
   */
  resolutionMode?: PnpmResolutionMode;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.autoInstallPeers}
   */
  autoInstallPeers?: boolean;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.alwaysInjectDependenciesFromOtherSubspaces}
   */
  alwaysInjectDependenciesFromOtherSubspaces?: boolean;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.alwaysFullInstall}
   */
  alwaysFullInstall?: boolean;
  /**
   * {@inheritDoc PnpmOptionsConfiguration.pnpmLockfilePolicies}
   */
  pnpmLockfilePolicies?: IPnpmLockfilePolicies;
}

/**
 * Options that are only used when the PNPM package manager is selected.
 * Use this class to load "common/config/rush/pnpm-config.json" file,
 * or, load json from "pnpmOptions" field in "rush.json" for legacy support.
 *
 * @remarks
 * It is valid to define these options in rush.json even if the PNPM package manager
 * is not being used.
 *
 * @public
 */
export class PnpmOptionsConfiguration extends PackageManagerOptionsConfigurationBase {
  private readonly _json: JsonObject;
  private _globalPatchedDependencies: Record<string, string> | undefined;

  /**
   * The method used to resolve the store used by PNPM.
   *
   * @remarks
   * Available options:
   *  - local: Use the standard Rush store path: common/temp/pnpm-store
   *  - global: Use PNPM's global store path
   */
  public readonly pnpmStore: PnpmStoreLocation;

  /**
   * This setting determines how PNPM chooses version numbers during `rush update`.
   *
   * @remarks
   * For example, suppose `lib-x@3.0.0` depends on `"lib-y": "^1.2.3"` whose latest major
   * releases are `1.8.9` and `2.3.4`.  The resolution mode `lowest-direct` might choose
   * `lib-y@1.2.3`, wheres `highest` will choose 1.8.9, and `time-based` will pick the
   * highest compatible version at the time when `lib-x@3.0.0` itself was published (ensuring
   * that the version could have been tested by the maintainer of "lib-x").  For local workspace
   * projects, `time-based` instead works like `lowest-direct`, avoiding upgrades unless
   * they are explicitly requested. Although `time-based` is the most robust option, it may be
   * slightly slower with registries such as npmjs.com that have not implemented an optimization.
   *
   * IMPORTANT: Be aware that PNPM 8.0.0 initially defaulted to `lowest-direct` instead of
   * `highest`, but PNPM reverted this decision in 8.6.12 because it caused confusion for users.
   * Rush version 5.106.0 and newer avoids this confusion by consistently defaulting to
   * `highest` when `resolutionMode` is not explicitly set in pnpm-config.json or .npmrc,
   * regardless of your PNPM version.
   *
   * PNPM documentation: https://pnpm.io/npmrc#resolution-mode
   *
   * Possible values are: `highest`, `time-based`, and `lowest-direct`.
   * The default is `highest`.
   */
  public readonly resolutionMode: PnpmResolutionMode | undefined;

  /**
   * The path for PNPM to use as the store directory.
   *
   * Will be overridden by environment variable RUSH_PNPM_STORE_PATH
   */
  public readonly pnpmStorePath: string;

  /**
   * The path for PNPM to use as the virtual store directory.
   *
   * Will be overridden by environment variable RUSH_PNPM_VIRTUAL_STORE_PATH
   */
  public readonly pnpmVirtualStorePath: string;

  /**
   * If true, then Rush will add the "--strict-peer-dependencies" option when invoking PNPM.
   *
   * @remarks
   * This causes "rush install" to fail if there are unsatisfied peer dependencies, which is
   * an invalid state that can cause build failures or incompatible dependency versions.
   * (For historical reasons, JavaScript package managers generally do not treat this invalid state
   * as an error.)
   *
   * The default value is false.  (For now.)
   */
  public readonly strictPeerDependencies: boolean;

  /**
   * If true, then `rush install` will report an error if manual modifications
   * were made to the PNPM shrinkwrap file without running `rush update` afterwards.
   *
   * @remarks
   * This feature protects against accidental inconsistencies that may be introduced
   * if the PNPM shrinkwrap file (`pnpm-lock.yaml`) is manually edited.  When this
   * feature is enabled, `rush update` will write a hash of the shrinkwrap contents to repo-state.json,
   * and then `rush update` and `rush install` will validate the hash.  Note that this does not prohibit
   * manual modifications, but merely requires `rush update` be run
   * afterwards, ensuring that PNPM can report or repair any potential inconsistencies.
   *
   * To temporarily disable this validation when invoking `rush install`, use the
   * `--bypass-policy` command-line parameter.
   *
   * The default value is false.
   */
  public readonly preventManualShrinkwrapChanges: boolean;

  /**
   * If true, then Rush will use the workspaces feature to install and link packages when invoking PNPM.
   *
   * @remarks
   * The default value is true.  (For now.)
   */
  public readonly useWorkspaces: boolean;

  /**
   * When true, any missing non-optional peer dependencies are automatically installed.
   *
   * @remarks
   * The default value is same as PNPM default value.  (In PNPM 8.x, this value is true)
   */
  public readonly autoInstallPeers: boolean | undefined;

  /**
   * If true, then `rush update` add injected install options for all cross-subspace
   * workspace dependencies, to avoid subspace doppelganger issue.
   *
   * Here, the injected install refers to PNPM's PNPM's "injected dependencies"
   * feature. Learn more: https://pnpm.io/package_json#dependenciesmeta
   *
   * @remarks
   * The default value is false.
   */
  public readonly alwaysInjectDependenciesFromOtherSubspaces: boolean | undefined;

  /**
   * The "globalOverrides" setting provides a simple mechanism for overriding version selections
   * for all dependencies of all projects in the monorepo workspace.  The settings are copied
   * into the `pnpm.overrides` field of the `common/temp/package.json` file that is generated
   * by Rush during installation.
   *
   * Order of precedence: `.pnpmfile.cjs` has the highest precedence, followed by
   * `unsupportedPackageJsonSettings`, `globalPeerDependencyRules`, `globalPackageExtensions`,
   * and `globalOverrides` has lowest precedence.
   *
   * PNPM documentation: https://pnpm.io/package_json#pnpmoverrides
   */
  public readonly globalOverrides: Record<string, string> | undefined;

  /**
   * The `globalPeerDependencyRules` setting provides various settings for suppressing validation errors
   * that are reported during installation with `strictPeerDependencies=true`.  The settings are copied
   * into the `pnpm.peerDependencyRules` field of the `common/temp/package.json` file that is generated
   * by Rush during installation.
   *
   * Order of precedence: `.pnpmfile.cjs` has the highest precedence, followed by
   * `unsupportedPackageJsonSettings`, `globalPeerDependencyRules`, `globalPackageExtensions`,
   * and `globalOverrides` has lowest precedence.
   *
   * https://pnpm.io/package_json#pnpmpeerdependencyrules
   */
  public readonly globalPeerDependencyRules: IPnpmPeerDependencyRules | undefined;

  /**
   * The `globalPackageExtension` setting provides a way to patch arbitrary package.json fields
   * for any PNPM dependency of the monorepo.  The settings are copied into the `pnpm.packageExtensions`
   * field of the `common/temp/package.json` file that is generated by Rush during installation.
   * The `globalPackageExtension` setting has similar capabilities as `.pnpmfile.cjs` but without
   * the downsides of an executable script (nondeterminism, unreliable caching, performance concerns).
   *
   * Order of precedence: `.pnpmfile.cjs` has the highest precedence, followed by
   * `unsupportedPackageJsonSettings`, `globalPeerDependencyRules`, `globalPackageExtensions`,
   * and `globalOverrides` has lowest precedence.
   *
   * PNPM documentation: https://pnpm.io/package_json#pnpmpackageextensions
   */
  public readonly globalPackageExtensions: Record<string, IPnpmPackageExtension> | undefined;

  /**
   * The `globalNeverBuiltDependencies` setting suppresses the `preinstall`, `install`, and `postinstall`
   * lifecycle events for the specified NPM dependencies.  This is useful for scripts with poor practices
   * such as downloading large binaries without retries or attempting to invoke OS tools such as
   * a C++ compiler.  (PNPM's terminology refers to these lifecycle events as "building" a package;
   * it has nothing to do with build system operations such as `rush build` or `rushx build`.)
   * The settings are copied into the `pnpm.neverBuiltDependencies` field of the `common/temp/package.json`
   * file that is generated by Rush during installation.
   *
   * PNPM documentation: https://pnpm.io/package_json#pnpmneverbuiltdependencies
   */
  public readonly globalNeverBuiltDependencies: string[] | undefined;

  /**
   * The ignoredOptionalDependencies setting allows you to exclude certain optional dependencies from being installed
   * during the Rush installation process. This can be useful when optional dependencies are not required or are
   * problematic in specific environments (e.g., dependencies with incompatible binaries or platform-specific requirements).
   * The listed dependencies will be treated as though they are missing, even if other packages specify them as optional
   * dependencies. The settings are copied into the pnpm.ignoredOptionalDependencies field of the common/temp/package.json
   * file that is generated by Rush during installation.
   *
   * (SUPPORTED ONLY IN PNPM 9.0.0 AND NEWER)
   *
   * PNPM documentation: https://pnpm.io/package_json#pnpmignoredoptionaldependencies
   */
  public readonly globalIgnoredOptionalDependencies: string[] | undefined;

  /**
   * The `globalAllowedDeprecatedVersions` setting suppresses installation warnings for package
   * versions that the NPM registry reports as being deprecated.  This is useful if the
   * deprecated package is an indirect dependency of an external package that has not released a fix.
   * The settings are copied into the `pnpm.allowedDeprecatedVersions` field of the `common/temp/package.json`
   * file that is generated by Rush during installation.
   *
   * PNPM documentation: https://pnpm.io/package_json#pnpmalloweddeprecatedversions
   *
   * If you are working to eliminate a deprecated version, it's better to specify `allowedDeprecatedVersions`
   * in the package.json file for individual Rush projects.
   */
  public readonly globalAllowedDeprecatedVersions: Record<string, string> | undefined;

  /**
   * (USE AT YOUR OWN RISK)  This is a free-form property bag that will be copied into
   * the `common/temp/package.json` file that is generated by Rush during installation.
   * This provides a way to experiment with new PNPM features.  These settings will override
   * any other Rush configuration associated with a given JSON field except for `.pnpmfile.cjs`.
   *
   * USAGE OF THIS SETTING IS NOT SUPPORTED BY THE RUSH MAINTAINERS AND MAY CAUSE RUSH
   * TO MALFUNCTION.  If you encounter a missing PNPM setting that you believe should
   * be supported, please create a GitHub issue or PR.  Note that Rush does not aim to
   * support every possible PNPM setting, but rather to promote a battle-tested installation
   * strategy that is known to provide a good experience for large teams with lots of projects.
   */
  public readonly unsupportedPackageJsonSettings: unknown | undefined;

  public readonly jsonFilename: string | undefined;

  /**
   * The `pnpmLockfilePolicies` setting defines the policies that govern the `pnpm-lock.yaml` file.
   */
  public readonly pnpmLockfilePolicies: IPnpmLockfilePolicies | undefined;

  /**
   * (EXPERIMENTAL) If "true", then filtered installs ("rush install --to my-project")
   * will be disregarded, instead always performing a full installation of the lockfile.
   * This setting is primarily useful with Rush subspaces which enable filtering across
   * multiple lockfiles, if filtering may be inefficient or undesirable for certain lockfiles.
   *
   * The default value is false.
   */
  /*[LINE "DEMO"]*/
  public readonly alwaysFullInstall: boolean | undefined;

  /**
   * (GENERATED BY RUSH-PNPM PATCH-COMMIT) When modifying this property, make sure you know what you are doing.
   *
   * The `globalPatchedDependencies` is added/updated automatically when you run pnpm patch-commit
   * command. It is a dictionary where the key should be the package name and exact version. The value
   * should be a relative path to a patch file.
   *
   * PNPM documentation: https://pnpm.io/package_json#pnpmpatcheddependencies
   */
  public get globalPatchedDependencies(): Record<string, string> | undefined {
    return this._globalPatchedDependencies;
  }

  private constructor(json: IPnpmOptionsJson, commonTempFolder: string, jsonFilename?: string) {
    super(json);
    this._json = json;
    this.jsonFilename = jsonFilename;
    this.pnpmStore = json.pnpmStore || 'local';
    if (EnvironmentConfiguration.pnpmStorePathOverride) {
      this.pnpmStorePath = EnvironmentConfiguration.pnpmStorePathOverride;
    } else if (this.pnpmStore === 'global') {
      this.pnpmStorePath = '';
    } else {
      this.pnpmStorePath = `${commonTempFolder}/pnpm-store`;
    }
    if (EnvironmentConfiguration.pnpmVirtualStorePathOverride) {
      this.pnpmVirtualStorePath = EnvironmentConfiguration.pnpmVirtualStorePathOverride;
    } else {
      this.pnpmVirtualStorePath = `${commonTempFolder}/.pnpm`;
    }
    this.strictPeerDependencies = !!json.strictPeerDependencies;
    this.preventManualShrinkwrapChanges = !!json.preventManualShrinkwrapChanges;
    this.useWorkspaces = !!json.useWorkspaces;

    this.globalOverrides = json.globalOverrides;
    this.globalPeerDependencyRules = json.globalPeerDependencyRules;
    this.globalPackageExtensions = json.globalPackageExtensions;
    this.globalNeverBuiltDependencies = json.globalNeverBuiltDependencies;
    this.globalIgnoredOptionalDependencies = json.globalIgnoredOptionalDependencies;
    this.globalAllowedDeprecatedVersions = json.globalAllowedDeprecatedVersions;
    this.unsupportedPackageJsonSettings = json.unsupportedPackageJsonSettings;
    this._globalPatchedDependencies = json.globalPatchedDependencies;
    this.resolutionMode = json.resolutionMode;
    this.autoInstallPeers = json.autoInstallPeers;
    this.alwaysInjectDependenciesFromOtherSubspaces = json.alwaysInjectDependenciesFromOtherSubspaces;
    this.alwaysFullInstall = json.alwaysFullInstall;
    this.pnpmLockfilePolicies = json.pnpmLockfilePolicies;
  }

  /** @internal */
  public static loadFromJsonFileOrThrow(
    jsonFilename: string,
    commonTempFolder: string
  ): PnpmOptionsConfiguration {
    // TODO: plumb through the terminal
    const terminal: Terminal = new Terminal(new ConsoleTerminalProvider());

    const pnpmOptionsConfigFile: NonProjectConfigurationFile<IPnpmOptionsJson> =
      new NonProjectConfigurationFile({
        jsonSchemaObject: schemaJson
      });
    const pnpmOptionJson: IPnpmOptionsJson = pnpmOptionsConfigFile.loadConfigurationFile(
      terminal,
      jsonFilename
    );
    return new PnpmOptionsConfiguration(pnpmOptionJson || {}, commonTempFolder, jsonFilename);
  }

  /** @internal */
  public static loadFromJsonObject(
    json: IPnpmOptionsJson,
    commonTempFolder: string
  ): PnpmOptionsConfiguration {
    return new PnpmOptionsConfiguration(json, commonTempFolder);
  }

  /**
   * Updates patchedDependencies field of the PNPM options in the common/config/rush/pnpm-config.json file.
   */
  public updateGlobalPatchedDependencies(patchedDependencies: Record<string, string> | undefined): void {
    this._globalPatchedDependencies = patchedDependencies;
    this._json.globalPatchedDependencies = patchedDependencies;
    if (this.jsonFilename) {
      JsonFile.save(this._json, this.jsonFilename, { updateExistingFile: true });
    }
  }
}
