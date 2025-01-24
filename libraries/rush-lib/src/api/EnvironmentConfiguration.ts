// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';
import * as path from 'path';
import { trueCasePathSync } from 'true-case-path';

import type { IEnvironment } from '../utilities/Utilities';

/**
 * @beta
 */
export interface IEnvironmentConfigurationInitializeOptions {
  doNotNormalizePaths?: boolean;
}

/**
 * Names of environment variables used by Rush.
 * @beta
 */
// eslint-disable-next-line @typescript-eslint/typedef
export const EnvironmentVariableNames = {
  /**
   * This variable overrides the temporary folder used by Rush.
   * The default value is "common/temp" under the repository root.
   *
   * @remarks This environment variable is not compatible with workspace installs. If attempting
   * to move the PNPM store path, see the `RUSH_PNPM_STORE_PATH` environment variable.
   */
  RUSH_TEMP_FOLDER: 'RUSH_TEMP_FOLDER',

  /**
   * This variable overrides the version of Rush that will be installed by
   * the version selector.  The default value is determined by the "rushVersion"
   * field from rush.json.
   */
  RUSH_PREVIEW_VERSION: 'RUSH_PREVIEW_VERSION',

  /**
   * This variable overrides the path of Rush that will used by the version selector.
   */
  RUSH_OVERRIDE_PATH: 'RUSH_OVERRIDE_PATH',

  /**
   * If this variable is set to "1", Rush will not fail the build when running a version
   * of Node that does not match the criteria specified in the "nodeSupportedVersionRange"
   * field from rush.json.
   */
  RUSH_ALLOW_UNSUPPORTED_NODEJS: 'RUSH_ALLOW_UNSUPPORTED_NODEJS',

  /**
   * Setting this environment variable overrides the value of `allowWarningsInSuccessfulBuild`
   * in the `command-line.json` configuration file. Specify `1` to allow warnings in a successful build,
   * or `0` to disallow them. (See the comments in the command-line.json file for more information).
   */
  RUSH_ALLOW_WARNINGS_IN_SUCCESSFUL_BUILD: 'RUSH_ALLOW_WARNINGS_IN_SUCCESSFUL_BUILD',

  /**
   * This variable selects a specific installation variant for Rush to use when installing
   * and linking package dependencies.
   * For more information, see the command-line help for the `--variant` parameter
   * and this article:  https://rushjs.io/pages/advanced/installation_variants/
   */
  RUSH_VARIANT: 'RUSH_VARIANT',

  /**
   * Specifies the maximum number of concurrent processes to launch during a build.
   * For more information, see the command-line help for the `--parallelism` parameter for "rush build".
   */
  RUSH_PARALLELISM: 'RUSH_PARALLELISM',

  /**
   * If this variable is set to "1", Rush will create symlinks with absolute paths instead
   * of relative paths. This can be necessary when a repository is moved during a build or
   * if parts of a repository are moved into a sandbox.
   */
  RUSH_ABSOLUTE_SYMLINKS: 'RUSH_ABSOLUTE_SYMLINKS',

  /**
   * When using PNPM as the package manager, this variable can be used to configure the path that
   * PNPM will use as the store directory.
   *
   * If a relative path is used, then the store path will be resolved relative to the process's
   * current working directory.  An absolute path is recommended.
   */
  RUSH_PNPM_STORE_PATH: 'RUSH_PNPM_STORE_PATH',

  /**
   * When using PNPM as the package manager, this variable can be used to control whether or not PNPM
   * validates the integrity of the PNPM store during installation. The value of this environment variable must be
   * `1` (for true) or `0` (for false). If not specified, defaults to the value in .npmrc.
   */
  RUSH_PNPM_VERIFY_STORE_INTEGRITY: 'RUSH_PNPM_VERIFY_STORE_INTEGRITY',

  /**
   * This environment variable can be used to specify the `--target-folder` parameter
   * for the "rush deploy" command.
   */
  RUSH_DEPLOY_TARGET_FOLDER: 'RUSH_DEPLOY_TARGET_FOLDER',

  /**
   * Overrides the location of the `~/.rush` global folder where Rush stores temporary files.
   *
   * @remarks
   *
   * Most of the temporary files created by Rush are stored separately for each monorepo working folder,
   * to avoid issues of concurrency and compatibility between tool versions.  However, a small set
   * of files (e.g. installations of the `@microsoft/rush-lib` engine and the package manager) are stored
   * in a global folder to speed up installations.  The default location is `~/.rush` on POSIX-like
   * operating systems or `C:\Users\YourName` on Windows.
   *
   * Use `RUSH_GLOBAL_FOLDER` to specify a different folder path.  This is useful for example if a Windows
   * group policy forbids executing scripts installed in a user's home directory.
   *
   * POSIX is a registered trademark of the Institute of Electrical and Electronic Engineers, Inc.
   */
  RUSH_GLOBAL_FOLDER: 'RUSH_GLOBAL_FOLDER',

  /**
   * Provides a credential for a remote build cache, if configured.  This credential overrides any cached credentials.
   *
   * @remarks
   * Setting this environment variable overrides whatever credential has been saved in the
   * local cloud cache credentials using `rush update-cloud-credentials`.
   *
   *
   * If Azure Blob Storage is used to store cache entries, this must be a SAS token serialized as query
   * parameters.
   *
   * For information on SAS tokens, see here: https://docs.microsoft.com/en-us/azure/storage/common/storage-sas-overview
   */
  RUSH_BUILD_CACHE_CREDENTIAL: 'RUSH_BUILD_CACHE_CREDENTIAL',

  /**
   * Setting this environment variable overrides the value of `buildCacheEnabled` in the `build-cache.json`
   * configuration file.
   *
   * @remarks
   * Specify `1` to enable the build cache or `0` to disable it.
   *
   * If there is no build cache configured, then this environment variable is ignored.
   */
  RUSH_BUILD_CACHE_ENABLED: 'RUSH_BUILD_CACHE_ENABLED',

  /**
   * Overrides the value of `isCacheWriteAllowed` in the `build-cache.json` configuration file. The value of this
   * environment variable must be `1` (for true) or `0` (for false). If there is no build cache configured, then
   * this environment variable is ignored.
   */
  RUSH_BUILD_CACHE_WRITE_ALLOWED: 'RUSH_BUILD_CACHE_WRITE_ALLOWED',

  /**
   * Setting this environment variable opts into running with cobuilds. The context id should be the same across
   * multiple VMs, but changed when it is a new round of cobuilds.
   *
   * e.g. `Build.BuildNumber` in Azure DevOps Pipeline.
   *
   * @remarks
   * If there is no cobuild configured, then this environment variable is ignored.
   */
  RUSH_COBUILD_CONTEXT_ID: 'RUSH_COBUILD_CONTEXT_ID',

  /**
   * Explicitly specifies a name for each participating cobuild runner.
   *
   * Setting this environment variable opts into running with cobuilds.
   *
   * @remarks
   * This environment variable is optional, if it is not provided, a random id is used.
   *
   * If there is no cobuild configured, then this environment variable is ignored.
   */
  RUSH_COBUILD_RUNNER_ID: 'RUSH_COBUILD_RUNNER_ID',

  /**
   * If this variable is set to "1", When getting distributed builds, Rush will automatically handle the leaf project
   * with build cache "disabled" by writing to the cache in a special "log files only mode". This is useful when you
   * want to use Cobuilds to improve the performance in CI validations and the leaf projects have not enabled cache.
   */
  RUSH_COBUILD_LEAF_PROJECT_LOG_ONLY_ALLOWED: 'RUSH_COBUILD_LEAF_PROJECT_LOG_ONLY_ALLOWED',

  /**
   * Explicitly specifies the path for the Git binary that is invoked by certain Rush operations.
   */
  RUSH_GIT_BINARY_PATH: 'RUSH_GIT_BINARY_PATH',

  /**
   * Explicitly specifies the path for the `tar` binary that is invoked by certain Rush operations.
   */
  RUSH_TAR_BINARY_PATH: 'RUSH_TAR_BINARY_PATH',

  /**
   * Internal variable used by `rushx` when recursively invoking another `rushx` process, to avoid
   * nesting event hooks.
   */
  _RUSH_RECURSIVE_RUSHX_CALL: '_RUSH_RECURSIVE_RUSHX_CALL',

  /**
   * Internal variable that explicitly specifies the path for the version of `@microsoft/rush-lib` being executed.
   * Will be set upon loading Rush.
   */
  _RUSH_LIB_PATH: '_RUSH_LIB_PATH',

  /**
   * When Rush executes shell scripts, it sometimes changes the working directory to be a project folder or
   * the repository root folder.  The original working directory (where the Rush command was invoked) is assigned
   * to the the child process's `RUSH_INVOKED_FOLDER` environment variable, in case it is needed by the script.
   *
   * @remarks
   * The `RUSH_INVOKED_FOLDER` variable is the same idea as the `INIT_CWD` variable that package managers
   * assign when they execute lifecycle scripts.
   */
  RUSH_INVOKED_FOLDER: 'RUSH_INVOKED_FOLDER',

  /**
   * When running a hook script, this environment variable communicates the original arguments
   * passed to the `rush` or `rushx` command.
   *
   * @remarks
   * Unlike `RUSH_INVOKED_FOLDER`, the `RUSH_INVOKED_ARGS` variable is only available for hook scripts.
   * Other lifecycle scripts should not make assumptions about Rush's command line syntax
   * if Rush did not explicitly pass along command-line parameters to their process.
   */
  RUSH_INVOKED_ARGS: 'RUSH_INVOKED_ARGS'
} as const;

/**
 * Provides Rush-specific environment variable data. All Rush environment variables must start with "RUSH_". This class
 * is designed to be used by RushConfiguration.
 * @beta
 *
 * @remarks
 * Initialize will throw if any unknown parameters are present.
 */
export class EnvironmentConfiguration {
  private static _hasBeenValidated: boolean = false;

  private static _rushTempFolderOverride: string | undefined;

  private static _absoluteSymlinks: boolean = false;

  private static _allowUnsupportedNodeVersion: boolean = false;

  private static _allowWarningsInSuccessfulBuild: boolean = false;

  private static _pnpmStorePathOverride: string | undefined;

  private static _pnpmVerifyStoreIntegrity: boolean | undefined;

  private static _rushGlobalFolderOverride: string | undefined;

  private static _buildCacheCredential: string | undefined;

  private static _buildCacheEnabled: boolean | undefined;

  private static _buildCacheWriteAllowed: boolean | undefined;

  private static _cobuildContextId: string | undefined;

  private static _cobuildRunnerId: string | undefined;

  private static _cobuildLeafProjectLogOnlyAllowed: boolean | undefined;

  private static _gitBinaryPath: string | undefined;

  private static _tarBinaryPath: string | undefined;

  /**
   * An override for the common/temp folder path.
   */
  public static get rushTempFolderOverride(): string | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._rushTempFolderOverride;
  }

  /**
   * If "1", create symlinks with absolute paths instead of relative paths.
   * See {@link EnvironmentVariableNames.RUSH_ABSOLUTE_SYMLINKS}
   */
  public static get absoluteSymlinks(): boolean {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._absoluteSymlinks;
  }

  /**
   * If this environment variable is set to "1", the Node.js version check will print a warning
   * instead of causing a hard error if the environment's Node.js version doesn't match the
   * version specifier in `rush.json`'s "nodeSupportedVersionRange" property.
   *
   * See {@link EnvironmentVariableNames.RUSH_ALLOW_UNSUPPORTED_NODEJS}.
   */
  public static get allowUnsupportedNodeVersion(): boolean {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._allowUnsupportedNodeVersion;
  }

  /**
   * Setting this environment variable overrides the value of `allowWarningsInSuccessfulBuild`
   * in the `command-line.json` configuration file. Specify `1` to allow warnings in a successful build,
   * or `0` to disallow them. (See the comments in the command-line.json file for more information).
   */
  public static get allowWarningsInSuccessfulBuild(): boolean {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._allowWarningsInSuccessfulBuild;
  }

  /**
   * An override for the PNPM store path, if `pnpmStore` configuration is set to 'path'
   * See {@link EnvironmentVariableNames.RUSH_PNPM_STORE_PATH}
   */
  public static get pnpmStorePathOverride(): string | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._pnpmStorePathOverride;
  }

  /**
   * If specified, enables or disables integrity verification of the pnpm store during install.
   * See {@link EnvironmentVariableNames.RUSH_PNPM_VERIFY_STORE_INTEGRITY}
   */
  public static get pnpmVerifyStoreIntegrity(): boolean | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._pnpmVerifyStoreIntegrity;
  }

  /**
   * Overrides the location of the `~/.rush` global folder where Rush stores temporary files.
   * See {@link EnvironmentVariableNames.RUSH_GLOBAL_FOLDER}
   */
  public static get rushGlobalFolderOverride(): string | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._rushGlobalFolderOverride;
  }

  /**
   * Provides a credential for reading from and writing to a remote build cache, if configured.
   * See {@link EnvironmentVariableNames.RUSH_BUILD_CACHE_CREDENTIAL}
   */
  public static get buildCacheCredential(): string | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._buildCacheCredential;
  }

  /**
   * If set, enables or disables the cloud build cache feature.
   * See {@link EnvironmentVariableNames.RUSH_BUILD_CACHE_ENABLED}
   */
  public static get buildCacheEnabled(): boolean | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._buildCacheEnabled;
  }

  /**
   * If set, enables or disables writing to the cloud build cache.
   * See {@link EnvironmentVariableNames.RUSH_BUILD_CACHE_WRITE_ALLOWED}
   */
  public static get buildCacheWriteAllowed(): boolean | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._buildCacheWriteAllowed;
  }

  /**
   * Provides a determined cobuild context id if configured
   * See {@link EnvironmentVariableNames.RUSH_COBUILD_CONTEXT_ID}
   */
  public static get cobuildContextId(): string | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._cobuildContextId;
  }

  /**
   * Provides a determined cobuild runner id if configured
   * See {@link EnvironmentVariableNames.RUSH_COBUILD_RUNNER_ID}
   */
  public static get cobuildRunnerId(): string | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._cobuildRunnerId;
  }

  /**
   * If set, enables or disables the cobuild leaf project log only feature.
   * See {@link EnvironmentVariableNames.RUSH_COBUILD_LEAF_PROJECT_LOG_ONLY_ALLOWED}
   */
  public static get cobuildLeafProjectLogOnlyAllowed(): boolean | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._cobuildLeafProjectLogOnlyAllowed;
  }

  /**
   * Allows the git binary path to be explicitly provided.
   * See {@link EnvironmentVariableNames.RUSH_GIT_BINARY_PATH}
   */
  public static get gitBinaryPath(): string | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._gitBinaryPath;
  }

  /**
   * Allows the tar binary path to be explicitly provided.
   * See {@link EnvironmentVariableNames.RUSH_TAR_BINARY_PATH}
   */
  public static get tarBinaryPath(): string | undefined {
    EnvironmentConfiguration._ensureValidated();
    return EnvironmentConfiguration._tarBinaryPath;
  }

  /**
   * The front-end RushVersionSelector relies on `RUSH_GLOBAL_FOLDER`, so its value must be read before
   * `EnvironmentConfiguration` is initialized (and actually before the correct version of `EnvironmentConfiguration`
   * is even installed). Thus we need to read this environment variable differently from all the others.
   * @internal
   */
  public static _getRushGlobalFolderOverride(processEnv: IEnvironment): string | undefined {
    const value: string | undefined = processEnv[EnvironmentVariableNames.RUSH_GLOBAL_FOLDER];
    if (value) {
      const normalizedValue: string | undefined =
        EnvironmentConfiguration._normalizeDeepestParentFolderPath(value);
      return normalizedValue;
    }
  }

  /**
   * Reads and validates environment variables. If any are invalid, this function will throw.
   */
  public static validate(options: IEnvironmentConfigurationInitializeOptions = {}): void {
    EnvironmentConfiguration.reset();

    const unknownEnvVariables: string[] = [];
    for (const envVarName in process.env) {
      if (process.env.hasOwnProperty(envVarName) && envVarName.match(/^RUSH_/i)) {
        const value: string | undefined = process.env[envVarName];
        // Environment variables are only case-insensitive on Windows
        const normalizedEnvVarName: string =
          os.platform() === 'win32' ? envVarName.toUpperCase() : envVarName;
        switch (normalizedEnvVarName) {
          case EnvironmentVariableNames.RUSH_TEMP_FOLDER: {
            EnvironmentConfiguration._rushTempFolderOverride =
              value && !options.doNotNormalizePaths
                ? EnvironmentConfiguration._normalizeDeepestParentFolderPath(value) || value
                : value;
            break;
          }

          case EnvironmentVariableNames.RUSH_ABSOLUTE_SYMLINKS: {
            EnvironmentConfiguration._absoluteSymlinks =
              EnvironmentConfiguration.parseBooleanEnvironmentVariable(
                EnvironmentVariableNames.RUSH_ABSOLUTE_SYMLINKS,
                value
              ) ?? false;
            break;
          }

          case EnvironmentVariableNames.RUSH_ALLOW_UNSUPPORTED_NODEJS: {
            if (value === 'true' || value === 'false') {
              // Small, undocumented acceptance of old "true" and "false" values for
              // users of RUSH_ALLOW_UNSUPPORTED_NODEJS in rush pre-v5.46.
              EnvironmentConfiguration._allowUnsupportedNodeVersion = value === 'true';
            } else {
              EnvironmentConfiguration._allowUnsupportedNodeVersion =
                EnvironmentConfiguration.parseBooleanEnvironmentVariable(
                  EnvironmentVariableNames.RUSH_ALLOW_UNSUPPORTED_NODEJS,
                  value
                ) ?? false;
            }
            break;
          }

          case EnvironmentVariableNames.RUSH_ALLOW_WARNINGS_IN_SUCCESSFUL_BUILD: {
            EnvironmentConfiguration._allowWarningsInSuccessfulBuild =
              EnvironmentConfiguration.parseBooleanEnvironmentVariable(
                EnvironmentVariableNames.RUSH_ALLOW_WARNINGS_IN_SUCCESSFUL_BUILD,
                value
              ) ?? false;
            break;
          }

          case EnvironmentVariableNames.RUSH_PNPM_STORE_PATH: {
            EnvironmentConfiguration._pnpmStorePathOverride =
              value && !options.doNotNormalizePaths
                ? EnvironmentConfiguration._normalizeDeepestParentFolderPath(value) || value
                : value;
            break;
          }

          case EnvironmentVariableNames.RUSH_PNPM_VERIFY_STORE_INTEGRITY: {
            EnvironmentConfiguration._pnpmVerifyStoreIntegrity =
              value === '1' ? true : value === '0' ? false : undefined;
            break;
          }

          case EnvironmentVariableNames.RUSH_GLOBAL_FOLDER: {
            // Handled specially below
            break;
          }

          case EnvironmentVariableNames.RUSH_BUILD_CACHE_CREDENTIAL: {
            EnvironmentConfiguration._buildCacheCredential = value;
            break;
          }

          case EnvironmentVariableNames.RUSH_BUILD_CACHE_ENABLED: {
            EnvironmentConfiguration._buildCacheEnabled =
              EnvironmentConfiguration.parseBooleanEnvironmentVariable(
                EnvironmentVariableNames.RUSH_BUILD_CACHE_ENABLED,
                value
              );
            break;
          }

          case EnvironmentVariableNames.RUSH_BUILD_CACHE_WRITE_ALLOWED: {
            EnvironmentConfiguration._buildCacheWriteAllowed =
              EnvironmentConfiguration.parseBooleanEnvironmentVariable(
                EnvironmentVariableNames.RUSH_BUILD_CACHE_WRITE_ALLOWED,
                value
              );
            break;
          }

          case EnvironmentVariableNames.RUSH_COBUILD_CONTEXT_ID: {
            EnvironmentConfiguration._cobuildContextId = value;
            break;
          }

          case EnvironmentVariableNames.RUSH_COBUILD_RUNNER_ID: {
            EnvironmentConfiguration._cobuildRunnerId = value;
            break;
          }

          case EnvironmentVariableNames.RUSH_COBUILD_LEAF_PROJECT_LOG_ONLY_ALLOWED: {
            EnvironmentConfiguration._cobuildLeafProjectLogOnlyAllowed =
              EnvironmentConfiguration.parseBooleanEnvironmentVariable(
                EnvironmentVariableNames.RUSH_COBUILD_LEAF_PROJECT_LOG_ONLY_ALLOWED,
                value
              );
            break;
          }

          case EnvironmentVariableNames.RUSH_GIT_BINARY_PATH: {
            EnvironmentConfiguration._gitBinaryPath = value;
            break;
          }

          case EnvironmentVariableNames.RUSH_TAR_BINARY_PATH: {
            EnvironmentConfiguration._tarBinaryPath = value;
            break;
          }

          case EnvironmentVariableNames.RUSH_PARALLELISM:
          case EnvironmentVariableNames.RUSH_PREVIEW_VERSION:
          case EnvironmentVariableNames.RUSH_OVERRIDE_PATH:
          case EnvironmentVariableNames.RUSH_VARIANT:
          case EnvironmentVariableNames.RUSH_DEPLOY_TARGET_FOLDER:
            // Handled by @microsoft/rush front end
            break;

          case EnvironmentVariableNames.RUSH_INVOKED_FOLDER:
          case EnvironmentVariableNames.RUSH_INVOKED_ARGS:
          case EnvironmentVariableNames._RUSH_LIB_PATH:
            // Assigned by Rush itself
            break;

          case EnvironmentVariableNames._RUSH_RECURSIVE_RUSHX_CALL:
            // Assigned/read internally by RushXCommandLine
            break;

          default:
            unknownEnvVariables.push(envVarName);
            break;
        }
      }
    }

    // This strictness intends to catch mistakes where variables are misspelled or not used correctly.
    if (unknownEnvVariables.length > 0) {
      throw new Error(
        'The following environment variables were found with the "RUSH_" prefix, but they are not ' +
          `recognized by this version of Rush: ${unknownEnvVariables.join(', ')}`
      );
    }

    // See doc comment for EnvironmentConfiguration._getRushGlobalFolderOverride().
    EnvironmentConfiguration._rushGlobalFolderOverride =
      EnvironmentConfiguration._getRushGlobalFolderOverride(process.env);

    EnvironmentConfiguration._hasBeenValidated = true;
  }

  /**
   * Resets EnvironmentConfiguration into an un-initialized state.
   */
  public static reset(): void {
    EnvironmentConfiguration._rushTempFolderOverride = undefined;

    EnvironmentConfiguration._hasBeenValidated = false;
  }

  private static _ensureValidated(): void {
    if (!EnvironmentConfiguration._hasBeenValidated) {
      EnvironmentConfiguration.validate();
    }
  }

  public static parseBooleanEnvironmentVariable(
    name: string,
    value: string | undefined
  ): boolean | undefined {
    if (value === '' || value === undefined) {
      return undefined;
    } else if (value === '0') {
      return false;
    } else if (value === '1') {
      return true;
    } else {
      throw new Error(
        `Invalid value "${value}" for the environment variable ${name}. Valid choices are 0 or 1.`
      );
    }
  }

  /**
   * Given a path to a folder (that may or may not exist), normalize the path, including casing,
   * to the first existing parent folder in the path.
   *
   * If no existing path can be found (for example, if the root is a volume that doesn't exist),
   * this function returns undefined.
   *
   * @example
   * If the following path exists on disk: `C:\Folder1\folder2\`
   * _normalizeFirstExistingFolderPath('c:\\folder1\\folder2\\temp\\subfolder')
   * returns 'C:\\Folder1\\folder2\\temp\\subfolder'
   */
  private static _normalizeDeepestParentFolderPath(folderPath: string): string | undefined {
    folderPath = path.normalize(folderPath);
    const endsWithSlash: boolean = folderPath.charAt(folderPath.length - 1) === path.sep;
    const parsedPath: path.ParsedPath = path.parse(folderPath);
    const pathRoot: string = parsedPath.root;
    const pathWithoutRoot: string = parsedPath.dir.substr(pathRoot.length);
    const pathParts: string[] = [...pathWithoutRoot.split(path.sep), parsedPath.name].filter(
      (part) => !!part
    );

    // Starting with all path sections, and eliminating one from the end during each loop iteration,
    // run trueCasePathSync. If trueCasePathSync returns without exception, we've found a subset
    // of the path that exists and we've now gotten the correct casing.
    //
    // Once we've found a parent folder that exists, append the path sections that didn't exist.
    for (let i: number = pathParts.length; i >= 0; i--) {
      const constructedPath: string = path.join(pathRoot, ...pathParts.slice(0, i));
      try {
        const normalizedConstructedPath: string = trueCasePathSync(constructedPath);
        const result: string = path.join(normalizedConstructedPath, ...pathParts.slice(i));
        if (endsWithSlash) {
          return `${result}${path.sep}`;
        } else {
          return result;
        }
      } catch (e) {
        // This path doesn't exist, continue to the next subpath
      }
    }

    return undefined;
  }
}
