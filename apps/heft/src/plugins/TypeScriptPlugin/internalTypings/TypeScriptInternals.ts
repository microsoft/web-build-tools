// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type * as TTypescript from 'typescript';

// The specifics of these types aren't important
/**
 * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/types.ts#L3969-L4010
 */
export interface IEmitResolver {}

/**
 * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/types.ts#L5969-L5988
 */
export interface IEmitHost {
  writeFile: TTypescript.WriteFileCallback;
}

/**
 * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/types.ts#L3338-L3341
 */
export interface IEmitTransformers {}

export interface IExtendedProgram extends TTypescript.Program {
  /**
   * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/types.ts#L3205
   */
  getSourceFiles(): ReadonlyArray<IExtendedSourceFile>;

  /**
   * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/program.ts#L1024-L1048
   */
  getCommonSourceDirectory(): string;
}
export interface IExtendedSourceFile extends TTypescript.SourceFile {
  /**
   * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/types.ts#L3011
   */
  version: string;

  /**
   * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/types.ts#L657
   */
  symbol: {
    exports: Map<string, unknown>;
  };
}

/**
 * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/utilities.ts#L3799-L3803
 */
export interface IResolveModuleNameResolutionHost {
  getCanonicalFileName(p: string): string;
  getCommonSourceDirectory(): string;
  getCurrentDirectory(): string;
}

export interface IExtendedTypeScript {
  /**
   * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/performance.ts#L3
   */
  performance: {
    /**
     * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/performance.ts#L110-L116
     */
    enable(): void;

    /**
     * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/performance.ts#L55-L61
     */
    mark(performanceMaker: string): void;

    /**
     * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/performance.ts#L72-L78
     */
    measure(measureName: string, startMarkName?: string, endMarkName?: string): void;

    /**
     * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/performance.ts#L94-L96
     */
    getDuration(measureName: string): number;

    /**
     * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/performance.ts#L85-L87
     */
    getCount(measureName: string): number;
  };

  /**
   * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/utilities.ts#L4720-L4734
   */
  readJson(filePath: string): object;

  /**
   * https://github.com/microsoft/TypeScript/blob/782c09d783e006a697b4ba6d1e7ec2f718ce8393/src/compiler/utilities.ts#L6540
   */
  matchFiles(
    path: string,
    extensions: ReadonlyArray<string> | undefined,
    excludes: ReadonlyArray<string> | undefined,
    includes: ReadonlyArray<string> | undefined,
    useCaseSensitiveFileNames: boolean,
    currentDirectory: string,
    depth: number | undefined,
    getFileSystemEntries: (path: string) => {
      readonly files: ReadonlyArray<string>;
      readonly directories: ReadonlyArray<string>;
    },
    realpath: (path: string) => string,
    directoryExists: (path: string) => boolean
  ): string[];

  /**
   * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/emitter.ts#L261-L614
   */
  emitFiles(
    resolver: IEmitResolver,
    host: IEmitHost,
    targetSourceFile: TTypescript.SourceFile | undefined,
    emitTransformers: IEmitTransformers,
    emitOnlyDtsFiles?: boolean,
    onlyBuildInfo?: boolean,
    forceDtsEmit?: boolean
  ): TTypescript.EmitResult;

  /**
   * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/transformer.ts#L30-L35
   */
  getTransformers(
    compilerOptions: TTypescript.CompilerOptions,
    customTransformers?: TTypescript.CustomTransformers,
    emitOnlyDtsFiles?: boolean
  ): IEmitTransformers;

  /**
   * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/utilities.ts#L6100-L6108
   */
  removeFileExtension(path: string): string;

  /**
   * https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/utilities.ts#L3826-L3833
   */
  getExternalModuleNameFromPath(
    host: IResolveModuleNameResolutionHost,
    fileName: string,
    referencePath?: string
  ): string;

  /**
   * https://github.com/microsoft/TypeScript/blob/7f022c58fb8b7253f23c49f0d9eee6fde82b477b/src/compiler/path.ts#L808
   */
  getRelativePathFromDirectory(fromDirectory: string, to: string, ignoreCase: boolean): string;

  /**
   * https://github.com/microsoft/TypeScript/blob/7f022c58fb8b7253f23c49f0d9eee6fde82b477b/src/compiler/path.ts#L263
   */
  getDirectoryPath(path: string): string;

  Diagnostics: {
    // https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/diagnosticMessages.json#L4252-L4255
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Found_1_error_Watching_for_file_changes: TTypescript.DiagnosticMessage;

    // https://github.com/microsoft/TypeScript/blob/5f597e69b2e3b48d788cb548df40bcb703c8adb1/src/compiler/diagnosticMessages.json#L4256-L4259
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Found_0_errors_Watching_for_file_changes: TTypescript.DiagnosticMessage;

    // https://github.com/microsoft/TypeScript/blob/2428ade1a91248e847f3e1561e31a9426650efee/src/compiler/diagnosticMessages.json#L2252
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Property_0_has_no_initializer_and_is_not_definitely_assigned_in_the_constructor: TTypescript.DiagnosticMessage;

    // https://github.com/microsoft/TypeScript/blob/2428ade1a91248e847f3e1561e31a9426650efee/src/compiler/diagnosticMessages.json#L4920
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Element_implicitly_has_an_any_type_because_expression_of_type_0_can_t_be_used_to_index_type_1: TTypescript.DiagnosticMessage;
  };
}

export type ExtendedTypeScript = typeof TTypescript & IExtendedTypeScript;
