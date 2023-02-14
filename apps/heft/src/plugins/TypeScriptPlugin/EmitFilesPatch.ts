// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { InternalError } from '@rushstack/node-core-library';
import type * as TTypescript from 'typescript';
import {
  ExtendedTypeScript,
  IEmitResolver,
  IEmitHost,
  IEmitTransformers,
  IExtendedSourceFile
} from './internalTypings/TypeScriptInternals';

export interface ICachedEmitModuleKind {
  moduleKind: TTypescript.ModuleKind;

  outFolderPath: string;

  /**
   * File extension to use instead of '.js' for emitted ECMAScript files.
   * For example, '.cjs' to indicate commonjs content, or '.mjs' to indicate ECMAScript modules.
   */
  jsExtensionOverride: string | undefined;

  /**
   * Set to true if this is the emit kind that is specified in the tsconfig.json.
   * Declarations are only emitted for the primary module kind.
   */
  isPrimary: boolean;
}

const JS_EXTENSION_REGEX: RegExp = /\.js(\.map)?$/;

export class EmitFilesPatch {
  private static _patchedTs: ExtendedTypeScript | undefined = undefined;

  private static _baseEmitFiles: any | undefined = undefined; // eslint-disable-line

  public static install(
    ts: ExtendedTypeScript,
    tsconfig: TTypescript.ParsedCommandLine,
    moduleKindsToEmit: ICachedEmitModuleKind[],
    changedFiles?: Set<IExtendedSourceFile>
  ): void {
    if (EmitFilesPatch._patchedTs === ts) {
      // We already patched this instance of TS
      return;
    }

    if (EmitFilesPatch._patchedTs !== undefined) {
      throw new InternalError(
        'EmitFilesPatch.install() cannot be called without first uninstalling the existing patch'
      );
    }

    EmitFilesPatch._patchedTs = ts;
    EmitFilesPatch._baseEmitFiles = ts.emitFiles;

    let foundPrimary: boolean = false;
    let defaultModuleKind: TTypescript.ModuleKind;

    for (const moduleKindToEmit of moduleKindsToEmit) {
      if (moduleKindToEmit.isPrimary) {
        if (foundPrimary) {
          throw new Error('Multiple primary module emit kinds encountered.');
        } else {
          foundPrimary = true;
        }

        defaultModuleKind = moduleKindToEmit.moduleKind;
      }
    }

    // Override the underlying file emitter to run itself once for each flavor
    // This is a rather inelegant way to convince the TypeScript compiler not to duplicate parse/link/check
    ts.emitFiles = (
      resolver: IEmitResolver,
      host: IEmitHost,
      targetSourceFile: IExtendedSourceFile | undefined,
      emitTransformers: IEmitTransformers,
      emitOnlyDtsFiles?: boolean,
      onlyBuildInfo?: boolean,
      forceDtsEmit?: boolean
    ): TTypescript.EmitResult => {
      if (onlyBuildInfo || emitOnlyDtsFiles) {
        // There should only be one tsBuildInfo and one set of declaration files
        return EmitFilesPatch._baseEmitFiles(
          resolver,
          host,
          targetSourceFile,
          emitTransformers,
          emitOnlyDtsFiles,
          onlyBuildInfo,
          forceDtsEmit
        );
      } else {
        if (targetSourceFile && changedFiles) {
          changedFiles.add(targetSourceFile);
        }

        let defaultModuleKindResult: TTypescript.EmitResult;
        const diagnostics: TTypescript.Diagnostic[] = [];
        let emitSkipped: boolean = false;
        for (const moduleKindToEmit of moduleKindsToEmit) {
          const compilerOptions: TTypescript.CompilerOptions = moduleKindToEmit.isPrimary
            ? {
                ...tsconfig.options
              }
            : {
                ...tsconfig.options,
                module: moduleKindToEmit.moduleKind,
                outDir: moduleKindToEmit.outFolderPath,

                // Don't emit declarations for secondary module kinds
                declaration: false,
                declarationMap: false
              };

          const { outDir, declaration, declarationDir } = compilerOptions;

          if (!declaration) {
            compilerOptions.declarationDir = undefined;
          }

          if (!outDir) {
            throw new InternalError('Expected compilerOptions.outDir to be assigned');
          }

          const { jsExtensionOverride } = moduleKindToEmit;
          // RegExp replacer function for renaming module file extensions
          const extensionReplacer: ((match: string, map: string) => string) | undefined = jsExtensionOverride
            ? (match: string, map: string) => {
                return map ? `${jsExtensionOverride}${map}` : jsExtensionOverride;
              }
            : undefined;

          // If the outDir is not the designated declaration directory, emit .d.ts redirector shims
          const createShims: boolean =
            (compilerOptions.isolatedModules && declarationDir && declarationDir !== outDir) || false;

          const outDirLength: number = outDir.endsWith('/') ? outDir.length - 1 : outDir.length;

          // Creates a .d.ts redirector for the specified file to a module in the declarationDir
          function createShim(fileName: string, sourceFile: TTypescript.SourceFile): string | undefined {
            if (!fileName.endsWith('.js')) {
              return;
            }

            const fileNameRelativeToOutDir: string = fileName.slice(outDirLength, -3);
            const relativeDeclarationFilePath: string = `${ts.getRelativePathFromDirectory(
              ts.getDirectoryPath(fileName),
              declarationDir!,
              false
            )}${fileNameRelativeToOutDir}`;

            // As long as the file is a module, `export * from` will work.
            let shim: string = `export * from '${relativeDeclarationFilePath}';`;
            // Reach into the binding layer to determine if there is an export named "default"
            const moduleHasDefaultExport: boolean | undefined = (
              sourceFile as IExtendedSourceFile
            ).symbol?.exports.has('default');
            if (moduleHasDefaultExport) {
              // If the module has a default export, need to explicitly forward it
              shim += `\nexport { default as default } from '${relativeDeclarationFilePath}';`;
            }

            return shim;
          }

          const flavorResult: TTypescript.EmitResult = EmitFilesPatch._baseEmitFiles(
            resolver,
            {
              ...host,
              writeFile: EmitFilesPatch.wrapWriteFile(
                host.writeFile,
                extensionReplacer,
                createShims ? createShim : undefined
              ),
              getCompilerOptions: () => compilerOptions
            },
            targetSourceFile,
            ts.getTransformers(compilerOptions, undefined, emitOnlyDtsFiles),
            emitOnlyDtsFiles,
            onlyBuildInfo,
            forceDtsEmit
          );

          emitSkipped = emitSkipped || flavorResult.emitSkipped;
          for (const diagnostic of flavorResult.diagnostics) {
            diagnostics.push(diagnostic);
          }

          if (moduleKindToEmit.moduleKind === defaultModuleKind) {
            defaultModuleKindResult = flavorResult;
          }
          // Should results be aggregated, in case for whatever reason the diagnostics are not the same?
        }

        const mergedDiagnostics: readonly TTypescript.Diagnostic[] =
          ts.sortAndDeduplicateDiagnostics(diagnostics);

        return {
          ...defaultModuleKindResult!,
          diagnostics: mergedDiagnostics,
          emitSkipped
        };
      }
    };
  }

  public static get isInstalled(): boolean {
    return this._patchedTs !== undefined;
  }

  /**
   * Wraps the writeFile callback on the IEmitHost to override the .js extension, if applicable
   */
  public static wrapWriteFile(
    baseWriteFile: TTypescript.WriteFileCallback,
    jsExtensionReplacer: ((match: string, map: string) => string) | undefined,
    createShim: ((fileName: string, sourceFile: TTypescript.SourceFile) => string | undefined) | undefined
  ): TTypescript.WriteFileCallback {
    if (!jsExtensionReplacer && !createShim) {
      return baseWriteFile;
    }

    return (
      fileName: string,
      data: string,
      writeBOM: boolean,
      onError?: ((message: string) => void) | undefined,
      sourceFiles?: readonly TTypescript.SourceFile[] | undefined
    ) => {
      if (createShim && sourceFiles) {
        const sourceFile: TTypescript.SourceFile = sourceFiles[0];
        const shim: string | undefined = createShim(fileName, sourceFile);

        if (shim) {
          const shimFileName: string = `${fileName.slice(0, -2)}d.ts`;
          baseWriteFile(shimFileName, shim, writeBOM, onError, sourceFiles);
        }
      }

      return baseWriteFile(
        jsExtensionReplacer ? fileName.replace(JS_EXTENSION_REGEX, jsExtensionReplacer) : fileName,
        data,
        writeBOM,
        onError,
        sourceFiles
      );
    };
  }

  public static uninstall(ts: ExtendedTypeScript): void {
    if (EmitFilesPatch._patchedTs === undefined) {
      throw new InternalError('EmitFilesPatch.uninstall() cannot be called if no patch was installed');
    }
    if (ts !== EmitFilesPatch._patchedTs) {
      throw new InternalError('EmitFilesPatch.uninstall() called for the wrong object');
    }

    ts.emitFiles = EmitFilesPatch._baseEmitFiles;

    EmitFilesPatch._patchedTs = undefined;
    EmitFilesPatch._baseEmitFiles = undefined;
  }
}
