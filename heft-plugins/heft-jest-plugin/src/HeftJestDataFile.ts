// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { FileSystem, JsonFile } from '@rushstack/node-core-library';

export const HEFT_JEST_DATA_FILENAME: string = 'heft-jest-data.json';

/**
 * Schema for heft-jest-data.json
 */
export interface IHeftJestDataFileJson {
  /**
   * The "emitFolderNameForTests" from config/typescript.json
   */
  folderNameForTests: string;

  /**
   * The file extension attached to compiled test files.
   */
  extensionForTests: '.js' | '.cjs' | '.mjs';

  /**
   * Whether or not the project being tested is a TypeScript project.
   */
  isTypeScriptProject: boolean;
}

/**
 * Manages loading/saving the "heft-jest-data.json" data file.  This file communicates
 * configuration information from Heft to jest-build-transform.js.  The jest-build-transform.js script gets
 * loaded dynamically by the Jest engine, so it does not have access to the normal HeftConfiguration objects.
 */
export class HeftJestDataFile {
  /**
   * Called by JestPlugin to write the file.
   */
  public static async saveForProjectAsync(projectFolder: string, json: IHeftJestDataFileJson): Promise<void> {
    await HeftJestDataFile._validateHeftJestDataFileAsync(json, projectFolder);
    const jsonFilePath: string = HeftJestDataFile.getConfigFilePath(projectFolder);
    await JsonFile.saveAsync(json, jsonFilePath, {
      ensureFolderExists: true,
      headerComment: '// THIS DATA FILE IS INTERNAL TO HEFT; DO NOT MODIFY IT OR RELY ON ITS CONTENTS'
    });
  }

  /**
   * Called by jest-build-transform.js to read the file. No validation is performed because validation
   * should be performed asynchronously in the JestPlugin.
   */
  public static loadForProject(projectFolder: string): IHeftJestDataFileJson {
    const jsonFilePath: string = HeftJestDataFile.getConfigFilePath(projectFolder);
    return JsonFile.load(jsonFilePath);
  }

  public static async loadForProjectAsync(projectFolder: string): Promise<IHeftJestDataFileJson> {
    const jsonFilePath: string = HeftJestDataFile.getConfigFilePath(projectFolder);
    return await JsonFile.loadAsync(jsonFilePath);
  }

  /**
   * Get the absolute path to the heft-jest-data.json file
   */
  public static getConfigFilePath(projectFolder: string): string {
    return path.join(projectFolder, 'temp', 'heft-jest-data.json');
  }

  private static async _validateHeftJestDataFileAsync(
    heftJestDataFile: IHeftJestDataFileJson,
    projectFolder: string
  ): Promise<void> {
    // Only need to validate if using TypeScript
    if (heftJestDataFile.isTypeScriptProject) {
      const emitFolderPathForJest: string = path.join(projectFolder, heftJestDataFile.folderNameForTests);
      if (!(await FileSystem.existsAsync(emitFolderPathForJest))) {
        throw new Error(
          'The transpiler output folder does not exist:\n  ' +
            emitFolderPathForJest +
            '\nWas the compiler invoked? Is the "emitFolderNameForTests" setting correctly' +
            ' specified in config/typescript.json?\n'
        );
      }
    }
  }
}
