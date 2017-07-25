import { Gulp } from 'gulp';
import * as path from 'path';
import * as fsx from 'fs-extra';
import * as glob from 'glob';
import { EOL } from 'os';
import {
  compileFromFile,
  Options as JsonSchemaOptions
} from 'json-schema-to-typescript';

import { GulpTask } from '@microsoft/gulp-core-build';

export interface IJsonSchemaToTsTaskConfig {
  /**
   * The pattern to use to match JSON schema files. Defaults to src\**\*.schema.json
   */
  sourcePattern?: string;

  /**
   * A function called to transform a JSON schema file path into the corresponding *.ts file path.
   */
  filePathTransform?: (originalPath: string) => string;

  /**
   * Options to pass to the json-schema-to-typescript compiler
   */
  compilerOptions?: Partial<JsonSchemaOptions>;
}

export class JsonSchemaToTsTask extends GulpTask<IJsonSchemaToTsTaskConfig> {
  public name: string = 'json-schema-to-ts';

  public taskConfig: IJsonSchemaToTsTaskConfig = {
    sourcePattern: 'src/**/*.schema.json',
    filePathTransform: (filePath: string) => {
      const fileDir: string = path.dirname(filePath);
      const fileBaseName: string = path.basename(filePath, path.extname(filePath));
      return path.join(fileDir, `${fileBaseName}.ts`);
    },
    compilerOptions: {
      bannerComment: [
        '/**',
        ' * This file was generated by a tool. Do not change this file, change the original JSON schema file',
        ' */'
      ].join(EOL),
      enableTrailingSemicolonForEnums: true,
      enableTrailingSemicolonForInterfaceProperties: true,
      enableTrailingSemicolonForInterfaces: true,
      enableTrailingSemicolonForTypes: true,
      indentWith: '  '
    }
  };

  public executeTask(gulp: Gulp, completeCallback: (error?: string) => void): void {
    const fullSourcePattern: string = path.join(
      this.buildConfig.rootPath,
      this.taskConfig.sourcePattern
    );

    const matches: string[] = glob.sync(fullSourcePattern);

    const compilePromises: Promise<void>[] = matches.map((match: string) => {
      return compileFromFile(match, this.taskConfig.compilerOptions).then((tsFile: string) => {
        fsx.writeFileSync(this.taskConfig.filePathTransform(match), tsFile);
      });
    });

    if (compilePromises.length === 0) {
      completeCallback();
    } else {
      Promise.all(compilePromises).then(() => completeCallback(), completeCallback);
    }
  }
}