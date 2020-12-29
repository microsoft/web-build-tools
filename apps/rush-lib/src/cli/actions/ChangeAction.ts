// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import colors from 'colors';
import ignore, { Ignore } from 'ignore';

import {
  CommandLineFlagParameter,
  CommandLineStringParameter,
  CommandLineChoiceParameter
} from '@rushstack/ts-command-line';
import { FileSystem, Path, AlreadyReportedError, Import } from '@rushstack/node-core-library';

import { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { IChangeFile, IChangeInfo, ChangeType } from '../../api/ChangeManagement';
import { VersionControl } from '../../utilities/VersionControl';
import { ChangeFile } from '../../api/ChangeFile';
import { BaseRushAction } from './BaseRushAction';
import { RushCommandLineParser } from '../RushCommandLineParser';
import { ChangeFiles } from '../../logic/ChangeFiles';
import {
  VersionPolicy,
  IndividualVersionPolicy,
  LockStepVersionPolicy,
  VersionPolicyDefinitionName
} from '../../api/VersionPolicy';

import type * as inquirerTypes from 'inquirer';
import { RushConstants } from '../../logic/RushConstants';
import { flatMap, memoize } from 'lodash';
const inquirer: typeof inquirerTypes = Import.lazy('inquirer', require);

export class ChangeAction extends BaseRushAction {
  private _verifyParameter!: CommandLineFlagParameter;
  private _noFetchParameter!: CommandLineFlagParameter;
  private _targetBranchParameter!: CommandLineStringParameter;
  private _changeEmailParameter!: CommandLineStringParameter;
  private _bulkChangeParameter!: CommandLineFlagParameter;
  private _bulkChangeMessageParameter!: CommandLineStringParameter;
  private _bulkChangeBumpTypeParameter!: CommandLineChoiceParameter;
  private _overwriteFlagParameter!: CommandLineFlagParameter;

  private _targetBranchName: string | undefined;

  public constructor(parser: RushCommandLineParser) {
    const documentation: string[] = [
      'Asks a series of questions and then generates a <branchname>-<timestamp>.json file ' +
        'in the common folder. The `publish` command will consume these files and perform the proper ' +
        'version bumps. Files will be excluded from change detection if they match an entry in a ' +
        `\`${RushConstants.changeignoreFileName}\` file in any parent directory of the modified file. ` +
        'The changes will eventually be published in a CHANGELOG.md file in each package.',
      '',
      'The possible types of changes are: ',
      '',
      'MAJOR - these are breaking changes that are not backwards compatible. ' +
        'Examples are: renaming a public class, adding/removing a non-optional ' +
        'parameter from a public API, or renaming an variable or function that ' +
        'is exported.',
      '',
      'MINOR - these are changes that are backwards compatible (but not ' +
        'forwards compatible). Examples are: adding a new public API or adding an ' +
        'optional parameter to a public API',
      '',
      'PATCH - these are changes that are backwards and forwards compatible. ' +
        'Examples are: Modifying a private API or fixing a bug in the logic ' +
        'of how an existing API works.',
      '',
      'HOTFIX (EXPERIMENTAL) - these are changes that are hotfixes targeting a ' +
        'specific older version of the package. When a hotfix change is added, ' +
        'other changes will not be able to increment the version number. ' +
        "Enable this feature by setting 'hotfixChangeEnabled' in your rush.json.",
      ''
    ];
    super({
      actionName: 'change',
      summary:
        'Records changes made to projects, indicating how the package version number should be bumped ' +
        'for the next publish.',
      documentation: documentation.join(os.EOL),
      safeForSimultaneousRushProcesses: true,
      parser
    });
  }

  public onDefineParameters(): void {
    const BULK_LONG_NAME: string = '--bulk';
    const BULK_MESSAGE_LONG_NAME: string = '--message';
    const BULK_BUMP_TYPE_LONG_NAME: string = '--bump-type';

    this._verifyParameter = this.defineFlagParameter({
      parameterLongName: '--verify',
      parameterShortName: '-v',
      description: 'Verify the change file has been generated and that it is a valid JSON file'
    });

    this._noFetchParameter = this.defineFlagParameter({
      parameterLongName: '--no-fetch',
      description: 'Skips fetching the baseline branch before running "git diff" to detect changes.'
    });

    this._targetBranchParameter = this.defineStringParameter({
      parameterLongName: '--target-branch',
      parameterShortName: '-b',
      argumentName: 'BRANCH',
      description:
        'If this parameter is specified, compare the checked out branch with the specified branch to ' +
        'determine which projects were changed. If this parameter is not specified, the checked out branch ' +
        'is compared against the "master" branch.'
    });

    this._overwriteFlagParameter = this.defineFlagParameter({
      parameterLongName: '--overwrite',
      description:
        `If a changefile already exists, overwrite without prompting ` +
        `(or erroring in ${BULK_LONG_NAME} mode).`
    });

    this._changeEmailParameter = this.defineStringParameter({
      parameterLongName: '--email',
      argumentName: 'EMAIL',
      description:
        'The email address to use in changefiles. If this parameter is not provided, the email address ' +
        'will be detected or prompted for in interactive mode.'
    });

    this._bulkChangeParameter = this.defineFlagParameter({
      parameterLongName: BULK_LONG_NAME,
      description:
        'If this flag is specified, apply the same change message and bump type to all changed projects. ' +
        `The ${BULK_MESSAGE_LONG_NAME} and the ${BULK_BUMP_TYPE_LONG_NAME} parameters must be specified if the ` +
        `${BULK_LONG_NAME} parameter is specified`
    });

    this._bulkChangeMessageParameter = this.defineStringParameter({
      parameterLongName: BULK_MESSAGE_LONG_NAME,
      argumentName: 'MESSAGE',
      description: `The message to apply to all changed projects if the ${BULK_LONG_NAME} flag is provided.`
    });

    this._bulkChangeBumpTypeParameter = this.defineChoiceParameter({
      parameterLongName: BULK_BUMP_TYPE_LONG_NAME,
      alternatives: [...Object.keys(this._getBumpOptions()), ChangeType[ChangeType.none]],
      description: `The bump type to apply to all changed projects if the ${BULK_LONG_NAME} flag is provided.`
    });
  }

  public async runAsync(): Promise<void> {
    console.log(`The target branch is ${this._targetBranch}`);

    if (this._verifyParameter.value) {
      const errors: string[] = [
        this._bulkChangeParameter,
        this._bulkChangeMessageParameter,
        this._bulkChangeBumpTypeParameter,
        this._overwriteFlagParameter
      ]
        .map((parameter) => {
          return parameter.value
            ? `The {${this._bulkChangeParameter.longName} parameter cannot be provided with the ` +
                `${this._verifyParameter.longName} parameter`
            : '';
        })
        .filter((error) => error !== '');
      if (errors.length > 0) {
        errors.forEach((error) => console.error(error));
        throw new AlreadyReportedError();
      }

      this._verify();
      return;
    }

    const sortedProjectList: string[] = this._getChangedPackageNames().sort();
    if (sortedProjectList.length === 0) {
      this._logNoChangeFileRequired();
      this._warnUncommittedChanges();
      return;
    }

    this._warnUncommittedChanges();

    const promptModule: inquirerTypes.PromptModule = inquirer.createPromptModule();
    let changeFileData: Map<string, IChangeFile> = new Map<string, IChangeFile>();
    let interactiveMode: boolean = false;
    if (this._bulkChangeParameter.value) {
      if (
        !this._bulkChangeBumpTypeParameter.value ||
        (!this._bulkChangeMessageParameter.value &&
          this._bulkChangeBumpTypeParameter.value !== ChangeType[ChangeType.none])
      ) {
        throw new Error(
          `The ${this._bulkChangeBumpTypeParameter.longName} and ${this._bulkChangeMessageParameter.longName} ` +
            `parameters must provided if the ${this._bulkChangeParameter.longName} flag is provided. If the value ` +
            `"${ChangeType[ChangeType.none]}" is provided to the ${
              this._bulkChangeBumpTypeParameter.longName
            } ` +
            `parameter, the ${this._bulkChangeMessageParameter.longName} parameter may be omitted.`
        );
      }

      const email: string | undefined = this._changeEmailParameter.value || this._detectEmail();
      if (!email) {
        throw new Error(
          "Unable to detect Git email and an email address wasn't provided using the " +
            `${this._changeEmailParameter.longName} paramter.`
        );
      }

      const errors: string[] = [];

      const comment: string = this._bulkChangeMessageParameter.value || '';
      const changeType: string = this._bulkChangeBumpTypeParameter.value;
      for (const packageName of sortedProjectList) {
        const allowedBumpTypes: string[] = Object.keys(this._getBumpOptions(packageName));
        let projectChangeType: string = changeType;
        if (allowedBumpTypes.length === 0) {
          projectChangeType = ChangeType[ChangeType.none];
        } else if (
          projectChangeType !== ChangeType[ChangeType.none] &&
          allowedBumpTypes.indexOf(projectChangeType) === -1
        ) {
          errors.push(`The "${projectChangeType}" change type is not allowed for package "${packageName}".`);
        }

        changeFileData.set(packageName, {
          changes: [
            {
              comment,
              type: projectChangeType,
              packageName
            } as IChangeInfo
          ],
          packageName,
          email
        });
      }

      if (errors.length > 0) {
        for (const error of errors) {
          console.error(error);
        }

        throw new AlreadyReportedError();
      }
    } else if (this._bulkChangeBumpTypeParameter.value || this._bulkChangeMessageParameter.value) {
      throw new Error(
        `The ${this._bulkChangeParameter.longName} flag must be provided with the ` +
          `${this._bulkChangeBumpTypeParameter.longName} and ${this._bulkChangeMessageParameter.longName} parameters.`
      );
    } else {
      interactiveMode = true;

      const existingChangeComments: Map<string, string[]> = ChangeFiles.getChangeComments(
        this._getChangeFiles()
      );
      changeFileData = await this._promptForChangeFileData(
        promptModule,
        sortedProjectList,
        existingChangeComments
      );

      const email: string = this._changeEmailParameter.value
        ? this._changeEmailParameter.value
        : await this._detectOrAskForEmail(promptModule);
      changeFileData.forEach((changeFile: IChangeFile) => {
        changeFile.email = email;
      });
    }

    try {
      return await this._writeChangeFiles(
        promptModule,
        changeFileData,
        this._overwriteFlagParameter.value,
        interactiveMode
      );
    } catch (error) {
      throw new Error(`There was an error creating a change file: ${error.toString()}`);
    }
  }

  private _generateHostMap(): Map<string, string> {
    const hostMap: Map<string, string> = new Map<string, string>();
    this.rushConfiguration.projects.forEach((project) => {
      let hostProjectName: string = project.packageName;
      if (project.versionPolicy && project.versionPolicy.isLockstepped) {
        const lockstepPolicy: LockStepVersionPolicy = project.versionPolicy as LockStepVersionPolicy;
        hostProjectName = lockstepPolicy.mainProject || project.packageName;
      }

      hostMap.set(project.packageName, hostProjectName);
    });

    return hostMap;
  }

  private _verify(): void {
    const changedPackages: string[] = this._getChangedPackageNames();
    if (changedPackages.length > 0) {
      this._validateChangeFile(changedPackages);
    } else {
      this._logNoChangeFileRequired();
    }
  }

  private get _targetBranch(): string {
    if (!this._targetBranchName) {
      this._targetBranchName =
        this._targetBranchParameter.value || VersionControl.getRemoteMasterBranch(this.rushConfiguration);
    }

    return this._targetBranchName;
  }

  private _getChangedPackageNames(): string[] {
    const changedFiles: string[] = VersionControl.getChangedFiles(
      this._targetBranch,
      this._noFetchParameter.value
    );
    if (changedFiles.length === 0) {
      return [];
    }
    const changedPackageNames: Set<string> = new Set<string>();

    const repoRootFolder: string | undefined = VersionControl.getRepositoryRootPath();
    const projectHostMap: Map<string, string> = this._generateHostMap();

    const getChangeIgnorePatterns: (fsPath: string) => string[] = memoize((fsPath: string): string[] => {
      if ((repoRootFolder && Path.isUnder(repoRootFolder, fsPath)) || !FileSystem.exists(fsPath)) {
        return [];
      }
      const parentIgnoreStrings: string[] = getChangeIgnorePatterns(path.dirname(fsPath));

      const changeIgnoreFilePath: string = path.join(fsPath, RushConstants.changeignoreFileName);

      return FileSystem.exists(changeIgnoreFilePath)
        ? [...parentIgnoreStrings, FileSystem.readFile(changeIgnoreFilePath)]
        : parentIgnoreStrings;
    });

    this.rushConfiguration.projects
      .filter((project) => project.shouldPublish)
      .filter((project) => !project.versionPolicy || !project.versionPolicy.exemptFromRushChange)
      .filter((project) => {
        const projectFolder: string = repoRootFolder
          ? path.relative(repoRootFolder, project.projectFolder)
          : project.projectRelativeFolder;
        return this._hasProjectChanged(changedFiles, projectFolder, getChangeIgnorePatterns);
      })
      .forEach((project) => {
        const hostName: string | undefined = projectHostMap.get(project.packageName);
        if (hostName) {
          changedPackageNames.add(hostName);
        }
      });

    return [...changedPackageNames];
  }

  private _validateChangeFile(changedPackages: string[]): void {
    const files: string[] = this._getChangeFiles();
    ChangeFiles.validate(files, changedPackages, this.rushConfiguration);
  }

  private _getChangeFiles(): string[] {
    return VersionControl.getChangedFiles(this._targetBranch, true, `common/changes/`).map((relativePath) => {
      return path.join(this.rushConfiguration.rushJsonFolder, relativePath);
    });
  }

  private _hasProjectChanged(
    changedFiles: string[],
    projectFolder: string,
    getChangeIgnorePatterns: (fsPath: string) => string[]
  ): boolean {
    const relevantFiles: string[] = changedFiles.filter((file) => Path.isUnderOrEqual(file, projectFolder));

    const ignoreConfig: Ignore = ignore();

    for (const ignorePattern of flatMap(relevantFiles.map(path.dirname), getChangeIgnorePatterns)) {
      ignoreConfig.add(ignorePattern);
    }

    return relevantFiles.some(ignoreConfig.createFilter());
  }

  /**
   * The main loop which prompts the user for information on changed projects.
   */
  private async _promptForChangeFileData(
    promptModule: inquirerTypes.PromptModule,
    sortedProjectList: string[],
    existingChangeComments: Map<string, string[]>
  ): Promise<Map<string, IChangeFile>> {
    const changedFileData: Map<string, IChangeFile> = new Map<string, IChangeFile>();

    for (const projectName of sortedProjectList) {
      const changeInfo: IChangeInfo | undefined = await this._askQuestions(
        promptModule,
        projectName,
        existingChangeComments
      );
      if (changeInfo) {
        // Save the info into the change file
        let changeFile: IChangeFile | undefined = changedFileData.get(changeInfo.packageName);
        if (!changeFile) {
          changeFile = {
            changes: [],
            packageName: changeInfo.packageName,
            email: undefined
          };
          changedFileData.set(changeInfo.packageName, changeFile!);
        }

        changeFile!.changes.push(changeInfo);
      }
    }

    return changedFileData;
  }

  /**
   * Asks all questions which are needed to generate changelist for a project.
   */
  private async _askQuestions(
    promptModule: inquirerTypes.PromptModule,
    packageName: string,
    existingChangeComments: Map<string, string[]>
  ): Promise<IChangeInfo | undefined> {
    console.log(`${os.EOL}${packageName}`);
    const comments: string[] | undefined = existingChangeComments.get(packageName);
    if (comments) {
      console.log(`Found existing comments:`);
      comments.forEach((comment) => {
        console.log(`    > ${comment}`);
      });
      const { appendComment }: { appendComment: 'skip' | 'append' } = await promptModule({
        name: 'appendComment',
        type: 'list',
        default: 'skip',
        message: 'Append to existing comments or skip?',
        choices: [
          {
            name: 'Skip',
            value: 'skip'
          },
          {
            name: 'Append',
            value: 'append'
          }
        ]
      });

      if (appendComment === 'skip') {
        return undefined;
      } else {
        return await this._promptForComments(promptModule, packageName);
      }
    } else {
      return await this._promptForComments(promptModule, packageName);
    }
  }

  private async _promptForComments(
    promptModule: inquirerTypes.PromptModule,
    packageName: string
  ): Promise<IChangeInfo | undefined> {
    const bumpOptions: { [type: string]: string } = this._getBumpOptions(packageName);
    const { comment }: { comment: string } = await promptModule({
      name: 'comment',
      type: 'input',
      message: `Describe changes, or ENTER if no changes:`
    });

    if (Object.keys(bumpOptions).length === 0 || !comment) {
      return {
        packageName: packageName,
        comment: comment || '',
        type: ChangeType[ChangeType.none]
      } as IChangeInfo;
    } else {
      const { bumpType }: { bumpType: string } = await promptModule({
        choices: Object.keys(bumpOptions).map((option) => {
          return {
            value: option,
            name: bumpOptions[option]
          };
        }),
        default: 'patch',
        message: 'Select the type of change:',
        name: 'bumpType',
        type: 'list'
      });

      return {
        packageName: packageName,
        comment: comment,
        type: bumpType
      } as IChangeInfo;
    }
  }

  private _getBumpOptions(packageName?: string): { [type: string]: string } {
    let bumpOptions: { [type: string]: string } =
      this.rushConfiguration && this.rushConfiguration.hotfixChangeEnabled
        ? {
            [ChangeType[ChangeType.hotfix]]:
              'hotfix - for changes that need to be published in a separate hotfix package'
          }
        : {
            [ChangeType[ChangeType.major]]:
              'major - for changes that break compatibility, e.g. removing an API',
            [ChangeType[ChangeType.minor]]: 'minor - for backwards compatible changes, e.g. adding a new API',
            [ChangeType[ChangeType.patch]]:
              'patch - for changes that do not affect compatibility, e.g. fixing a bug'
          };

    if (packageName) {
      const project: RushConfigurationProject | undefined = this.rushConfiguration.getProjectByName(
        packageName
      );
      const versionPolicy: VersionPolicy | undefined = project!.versionPolicy;

      if (versionPolicy) {
        if (versionPolicy.definitionName === VersionPolicyDefinitionName.lockStepVersion) {
          // No need to ask for bump types if project is lockstep versioned.
          bumpOptions = {};
        } else if (versionPolicy.definitionName === VersionPolicyDefinitionName.individualVersion) {
          const individualPolicy: IndividualVersionPolicy = versionPolicy as IndividualVersionPolicy;
          if (individualPolicy.lockedMajor !== undefined) {
            delete bumpOptions[ChangeType[ChangeType.major]];
          }
        }
      }
    }

    return bumpOptions;
  }

  /**
   * Will determine a user's email by first detecting it from their Git config,
   * or will ask for it if it is not found or the Git config is wrong.
   */
  private async _detectOrAskForEmail(promptModule: inquirerTypes.PromptModule): Promise<string> {
    return (await this._detectAndConfirmEmail(promptModule)) || (await this._promptForEmail(promptModule));
  }

  private _detectEmail(): string | undefined {
    try {
      return child_process
        .execSync('git config user.email')
        .toString()
        .replace(/(\r\n|\n|\r)/gm, '');
    } catch (err) {
      console.log('There was an issue detecting your Git email...');
      return undefined;
    }
  }

  /**
   * Detects the user's email address from their Git configuration, prompts the user to approve the
   * detected email. It returns undefined if it cannot be detected.
   */
  private async _detectAndConfirmEmail(
    promptModule: inquirerTypes.PromptModule
  ): Promise<string | undefined> {
    const email: string | undefined = this._detectEmail();

    if (email) {
      const { isCorrectEmail }: { isCorrectEmail: boolean } = await promptModule([
        {
          type: 'confirm',
          name: 'isCorrectEmail',
          default: 'Y',
          message: `Is your email address ${email}?`
        }
      ]);
      return isCorrectEmail ? email : undefined;
    } else {
      return undefined;
    }
  }

  /**
   * Asks the user for their email address
   */
  private async _promptForEmail(promptModule: inquirerTypes.PromptModule): Promise<string> {
    const { email }: { email: string } = await promptModule([
      {
        type: 'input',
        name: 'email',
        message: 'What is your email address?',
        validate: (input: string) => {
          return true; // @todo should be an email
        }
      }
    ]);
    return email;
  }

  private _warnUncommittedChanges(): void {
    try {
      if (VersionControl.hasUncommittedChanges()) {
        console.log(
          os.EOL +
            colors.yellow(
              'Warning: You have uncommitted changes, which do not trigger prompting for change ' +
                'descriptions.'
            )
        );
      }
    } catch (error) {
      console.log(`An error occurred when detecting uncommitted changes: ${error}`);
    }
  }

  /**
   * Writes change files to the common/changes folder. Will prompt for overwrite if file already exists.
   */
  private async _writeChangeFiles(
    promptModule: inquirerTypes.PromptModule,
    changeFileData: Map<string, IChangeFile>,
    overwrite: boolean,
    interactiveMode: boolean
  ): Promise<void> {
    await changeFileData.forEach(async (changeFile: IChangeFile) => {
      await this._writeChangeFile(promptModule, changeFile, overwrite, interactiveMode);
    });
  }

  private async _writeChangeFile(
    promptModule: inquirerTypes.PromptModule,
    changeFileData: IChangeFile,
    overwrite: boolean,
    interactiveMode: boolean
  ): Promise<void> {
    const output: string = JSON.stringify(changeFileData, undefined, 2);
    const changeFile: ChangeFile = new ChangeFile(changeFileData, this.rushConfiguration);
    const filePath: string = changeFile.generatePath();

    const fileExists: boolean = FileSystem.exists(filePath);
    const shouldWrite: boolean =
      !fileExists ||
      overwrite ||
      (interactiveMode ? await this._promptForOverwrite(promptModule, filePath) : false);

    if (!interactiveMode && fileExists && !overwrite) {
      throw new Error(`Changefile ${filePath} already exists`);
    }

    if (shouldWrite) {
      this._writeFile(filePath, output, shouldWrite && fileExists);
    }
  }

  private async _promptForOverwrite(
    promptModule: inquirerTypes.PromptModule,
    filePath: string
  ): Promise<boolean> {
    const overwrite: boolean = await promptModule([
      {
        name: 'overwrite',
        type: 'confirm',
        message: `Overwrite ${filePath}?`
      }
    ]);

    if (overwrite) {
      return true;
    } else {
      console.log(`Not overwriting ${filePath}`);
      return false;
    }
  }

  /**
   * Writes a file to disk, ensuring the directory structure up to that point exists
   */
  private _writeFile(fileName: string, output: string, isOverwrite: boolean): void {
    FileSystem.writeFile(fileName, output, { ensureFolderExists: true });
    if (isOverwrite) {
      console.log(`Overwrote file: ${fileName}`);
    } else {
      console.log(`Created file: ${fileName}`);
    }
  }

  private _logNoChangeFileRequired(): void {
    console.log('No changes were detected to relevant packages on this branch. Nothing to do.');
  }
}
