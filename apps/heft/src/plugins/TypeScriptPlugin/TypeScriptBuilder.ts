// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as crypto from 'crypto';
import * as path from 'path';
import * as semver from 'semver';
import {
  FileSystemStats,
  ITerminal,
  JsonFile,
  IPackageJson,
  ITerminalProvider,
  FileSystem,
  Path,
  Async,
  FileError
} from '@rushstack/node-core-library';
import type * as TTypescript from 'typescript';
import {
  ExtendedTypeScript,
  IExtendedProgram,
  IExtendedSourceFile
} from './internalTypings/TypeScriptInternals';

import {
  ISubprocessRunnerBaseConfiguration,
  SubprocessRunnerBase
} from '../../utilities/subprocess/SubprocessRunnerBase';
import { PerformanceMeasurer, PerformanceMeasurerAsync } from '../../utilities/Performance';
import { Tslint } from './Tslint';
import { Eslint } from './Eslint';
import { IScopedLogger } from '../../pluginFramework/logging/ScopedLogger';

import { EmitFilesPatch, ICachedEmitModuleKind } from './EmitFilesPatch';
import { HeftSession } from '../../pluginFramework/HeftSession';
import { EmitCompletedCallbackManager } from './EmitCompletedCallbackManager';
import { ISharedTypeScriptConfiguration } from './TypeScriptPlugin';
import { TypeScriptCachedFileSystem } from '../../utilities/fileSystem/TypeScriptCachedFileSystem';
import { LinterBase } from './LinterBase';

interface ILinterWrapper {
  ts: ExtendedTypeScript;
  logger: IScopedLogger;
  measureTsPerformance: PerformanceMeasurer;
  measureTsPerformanceAsync: PerformanceMeasurerAsync;
}

export interface ITypeScriptBuilderConfiguration
  extends ISharedTypeScriptConfiguration,
    ISubprocessRunnerBaseConfiguration {
  /**
   * The folder to write build metadata.
   */
  buildMetadataFolder: string;
  typeScriptToolPath: string;
  tslintToolPath: string | undefined;
  eslintToolPath: string | undefined;

  lintingEnabled: boolean;

  watchMode: boolean;

  /**
   * The path to the tsconfig file being built.
   */
  tsconfigPath: string;

  /**
   * Set this to change the maximum number of file handles that will be opened concurrently for writing.
   * The default is 50.
   */
  maxWriteParallelism: number;
}

type TWatchCompilerHost =
  TTypescript.WatchCompilerHostOfFilesAndCompilerOptions<TTypescript.EmitAndSemanticDiagnosticsBuilderProgram>;
type TSolutionHost = TTypescript.SolutionBuilderHost<TTypescript.EmitAndSemanticDiagnosticsBuilderProgram>;
type TWatchSolutionHost =
  TTypescript.SolutionBuilderWithWatchHost<TTypescript.EmitAndSemanticDiagnosticsBuilderProgram>;

const EMPTY_JSON: object = {};

interface ICompilerCapabilities {
  /**
   * Support for incremental compilation via `ts.createIncrementalProgram()`.
   * Introduced with TypeScript 3.6.
   */
  incrementalProgram: boolean;

  /**
   * Support for composite projects via `ts.createSolutionBuilder()`.
   * Introduced with TypeScript 3.0.
   */
  solutionBuilder: boolean;
}

interface IFileToWrite {
  filePath: string;
  data: string;
}

interface IModuleKindReason {
  kind: keyof typeof TTypescript.ModuleKind;
  outDir: string;
  extension: '.js' | '.cjs' | '.mjs';
  reason: string;
}

interface IExtendedEmitResult extends TTypescript.EmitResult {
  changedSourceFiles: Set<IExtendedSourceFile>;
  filesToWrite: IFileToWrite[];
}

const OLDEST_SUPPORTED_TS_MAJOR_VERSION: number = 2;
const OLDEST_SUPPORTED_TS_MINOR_VERSION: number = 9;

const NEWEST_SUPPORTED_TS_MAJOR_VERSION: number = 4;
const NEWEST_SUPPORTED_TS_MINOR_VERSION: number = 8;

export class TypeScriptBuilder extends SubprocessRunnerBase<ITypeScriptBuilderConfiguration> {
  private _typescriptVersion!: string;
  private _typescriptParsedVersion!: semver.SemVer;

  private _capabilities!: ICompilerCapabilities;
  private _useSolutionBuilder!: boolean;

  private _eslintEnabled!: boolean;
  private _tslintEnabled!: boolean;
  private _moduleKindsToEmit!: ICachedEmitModuleKind[];
  private _eslintConfigFilePath!: string;
  private _tslintConfigFilePath!: string;
  private _typescriptLogger!: IScopedLogger;
  private _typescriptTerminal!: ITerminal;
  private _emitCompletedCallbackManager: EmitCompletedCallbackManager;

  private __tsCacheFilePath: string | undefined;
  private _tsReadJsonCache: Map<string, object> = new Map<string, object>();
  private _cachedFileSystem: TypeScriptCachedFileSystem = new TypeScriptCachedFileSystem();

  public get filename(): string {
    return __filename;
  }

  private get _tsCacheFilePath(): string {
    if (!this.__tsCacheFilePath) {
      // TypeScript internally handles if the tsconfig options have changed from when the tsbuildinfo file was created.
      // We only need to hash our additional Heft configuration.
      const configHash: crypto.Hash = crypto.createHash('sha1');

      configHash.update(JSON.stringify(this._configuration.additionalModuleKindsToEmit || {}));
      const serializedConfigHash: string = configHash
        .digest('base64')
        .slice(0, 8)
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      // This conversion is theoretically redundant, but it is here to make absolutely sure that the path is formatted
      // using only '/' as the directory separator so that incremental builds don't break on Windows.
      // TypeScript will normalize to '/' when serializing, but not on the direct input, and uses exact string equality.
      const normalizedCacheFolder: string = Path.convertToSlashes(this._configuration.buildMetadataFolder);
      this.__tsCacheFilePath = `${normalizedCacheFolder}/ts_${serializedConfigHash}.json`;
    }

    return this.__tsCacheFilePath;
  }

  public constructor(
    parentGlobalTerminalProvider: ITerminalProvider,
    configuration: ITypeScriptBuilderConfiguration,
    heftSession: HeftSession,
    emitCallback: () => void
  ) {
    super(parentGlobalTerminalProvider, configuration, heftSession);

    this._emitCompletedCallbackManager = new EmitCompletedCallbackManager(emitCallback);
    this.registerSubprocessCommunicationManager(this._emitCompletedCallbackManager);
  }

  public async invokeAsync(): Promise<void> {
    this._typescriptLogger = await this.requestScopedLoggerAsync('typescript');
    this._typescriptTerminal = this._typescriptLogger.terminal;

    // Determine the compiler version
    const compilerPackageJsonFilename: string = path.join(
      this._configuration.typeScriptToolPath,
      'package.json'
    );
    const packageJson: IPackageJson = JsonFile.load(compilerPackageJsonFilename);
    this._typescriptVersion = packageJson.version;
    const parsedVersion: semver.SemVer | null = semver.parse(this._typescriptVersion);
    if (!parsedVersion) {
      throw new Error(
        `Unable to parse version "${this._typescriptVersion}" for TypeScript compiler package in: ` +
          compilerPackageJsonFilename
      );
    }
    this._typescriptParsedVersion = parsedVersion;

    // Detect what features this compiler supports.  Note that manually comparing major/minor numbers
    // loosens the matching to accept prereleases such as "3.6.0-dev.20190530"
    this._capabilities = {
      incrementalProgram: false,
      solutionBuilder: this._typescriptParsedVersion.major >= 3
    };

    if (
      this._typescriptParsedVersion.major > 3 ||
      (this._typescriptParsedVersion.major === 3 && this._typescriptParsedVersion.minor >= 6)
    ) {
      this._capabilities.incrementalProgram = true;
    }

    this._useSolutionBuilder = !!this._configuration.buildProjectReferences;
    if (this._useSolutionBuilder && !this._capabilities.solutionBuilder) {
      throw new Error(
        `Building project references requires TypeScript@>=3.0, but the current version is ${this._typescriptVersion}`
      );
    }

    this._tslintConfigFilePath = path.resolve(this._configuration.buildFolder, 'tslint.json');
    this._eslintEnabled = this._tslintEnabled =
      this._configuration.lintingEnabled && !this._configuration.watchMode; // Don't run lint in watch mode

    if (this._tslintEnabled) {
      this._tslintEnabled = this._cachedFileSystem.exists(this._tslintConfigFilePath);
    }

    this._eslintConfigFilePath = this._resolveEslintConfigFilePath(this._eslintEnabled);
    if (this._eslintEnabled) {
      this._eslintEnabled = this._cachedFileSystem.exists(this._eslintConfigFilePath);
    }

    // Report a warning if the TypeScript version is too old/new.  The current oldest supported version is
    // TypeScript 2.9. Prior to that the "ts.getConfigFileParsingDiagnostics()" API is missing; more fixups
    // would be required to deal with that.  We won't do that work unless someone requests it.
    if (
      this._typescriptParsedVersion.major < OLDEST_SUPPORTED_TS_MAJOR_VERSION ||
      (this._typescriptParsedVersion.major === OLDEST_SUPPORTED_TS_MAJOR_VERSION &&
        this._typescriptParsedVersion.minor < OLDEST_SUPPORTED_TS_MINOR_VERSION)
    ) {
      // We don't use writeWarningLine() here because, if the person wants to take their chances with
      // a seemingly unsupported compiler, their build should be allowed to succeed.
      this._typescriptTerminal.writeLine(
        `The TypeScript compiler version ${this._typescriptVersion} is very old` +
          ` and has not been tested with Heft; it may not work correctly.`
      );
    } else if (
      this._typescriptParsedVersion.major > NEWEST_SUPPORTED_TS_MAJOR_VERSION ||
      (this._typescriptParsedVersion.major === NEWEST_SUPPORTED_TS_MAJOR_VERSION &&
        this._typescriptParsedVersion.minor > NEWEST_SUPPORTED_TS_MINOR_VERSION)
    ) {
      this._typescriptTerminal.writeLine(
        `The TypeScript compiler version ${this._typescriptVersion} is newer` +
          ' than the latest version that was tested with Heft ' +
          `(${NEWEST_SUPPORTED_TS_MAJOR_VERSION}.${NEWEST_SUPPORTED_TS_MINOR_VERSION}); it may not work correctly.`
      );
    }

    const ts: ExtendedTypeScript = require(this._configuration.typeScriptToolPath);

    ts.performance.enable();

    const measureTsPerformance: PerformanceMeasurer = <TResult extends object | void>(
      measurementName: string,
      fn: () => TResult
    ) => {
      const beforeName: string = `before${measurementName}`;
      ts.performance.mark(beforeName);
      const result: TResult = fn();
      const afterName: string = `after${measurementName}`;
      ts.performance.mark(afterName);
      ts.performance.measure(measurementName, beforeName, afterName);
      return {
        ...result,
        duration: ts.performance.getDuration(measurementName),
        count: ts.performance.getCount(beforeName)
      };
    };

    const measureTsPerformanceAsync: PerformanceMeasurerAsync = async <TResult extends object | void>(
      measurementName: string,
      fn: () => Promise<TResult>
    ) => {
      const beforeName: string = `before${measurementName}`;
      ts.performance.mark(beforeName);
      const resultPromise: Promise<TResult> = fn();
      const result: TResult = await resultPromise;
      const afterName: string = `after${measurementName}`;
      ts.performance.mark(afterName);
      ts.performance.measure(measurementName, beforeName, afterName);
      return {
        ...result,
        duration: ts.performance.getDuration(measurementName)
      };
    };

    this._typescriptTerminal.writeLine(`Using TypeScript version ${ts.version}`);

    if (this._configuration.watchMode) {
      await this._runWatch(ts, measureTsPerformance);
    } else if (this._useSolutionBuilder) {
      await this._runSolutionBuildAsync(ts, measureTsPerformance, measureTsPerformanceAsync);
    } else {
      await this._runBuildAsync(ts, measureTsPerformance, measureTsPerformanceAsync);
    }
  }

  private _resolveEslintConfigFilePath(eslintEnabled: boolean): string {
    const defaultPath: string = path.resolve(this._configuration.buildFolder, '.eslintrc.js');
    if (!eslintEnabled) {
      return defaultPath; // No need to check the filesystem
    }
    // When project is configured with "type": "module" in package.json, the config file must have a .cjs extension
    // so use it if it exists
    const alternativePathPath: string = path.resolve(this._configuration.buildFolder, '.eslintrc.cjs');
    if (this._cachedFileSystem.exists(alternativePathPath)) {
      return alternativePathPath;
    }
    return defaultPath;
  }

  public async _runWatch(ts: ExtendedTypeScript, measureTsPerformance: PerformanceMeasurer): Promise<void> {
    //#region CONFIGURE
    const { duration: configureDurationMs, tsconfig } = measureTsPerformance('Configure', () => {
      const _tsconfig: TTypescript.ParsedCommandLine = this._loadTsconfig(ts);
      this._validateTsconfig(ts, _tsconfig);
      EmitFilesPatch.install(ts, _tsconfig, this._moduleKindsToEmit);

      return {
        tsconfig: _tsconfig
      };
    });
    this._typescriptTerminal.writeVerboseLine(`Configure: ${configureDurationMs}ms`);
    //#endregion

    if (this._useSolutionBuilder) {
      const solutionHost: TWatchSolutionHost = this._buildWatchSolutionBuilderHost(ts);
      const watchBuilder: TTypescript.SolutionBuilder<TTypescript.EmitAndSemanticDiagnosticsBuilderProgram> =
        ts.createSolutionBuilderWithWatch(solutionHost, [this._configuration.tsconfigPath], {});

      watchBuilder.build();
    } else {
      const compilerHost: TWatchCompilerHost = this._buildWatchCompilerHost(ts, tsconfig);
      ts.createWatchProgram(compilerHost);
    }

    return new Promise(() => {
      /* never terminate */
    });
  }

  public async _runBuildAsync(
    ts: ExtendedTypeScript,
    measureTsPerformance: PerformanceMeasurer,
    measureTsPerformanceAsync: PerformanceMeasurerAsync
  ): Promise<void> {
    //#region CONFIGURE
    const {
      duration: configureDurationMs,
      tsconfig,
      compilerHost
    } = measureTsPerformance('Configure', () => {
      this._overrideTypeScriptReadJson(ts);
      const _tsconfig: TTypescript.ParsedCommandLine = this._loadTsconfig(ts);
      this._validateTsconfig(ts, _tsconfig);

      const _compilerHost: TTypescript.CompilerHost = this._buildIncrementalCompilerHost(ts, _tsconfig);

      return {
        tsconfig: _tsconfig,
        compilerHost: _compilerHost
      };
    });
    this._typescriptTerminal.writeVerboseLine(`Configure: ${configureDurationMs}ms`);
    //#endregion

    //#region PROGRAM
    // There will be only one program here; emit will get a bit abused if we produce multiple outputs
    let builderProgram: TTypescript.BuilderProgram | undefined = undefined;
    let tsProgram: TTypescript.Program;

    if (tsconfig.options.incremental) {
      builderProgram = ts.createIncrementalProgram({
        rootNames: tsconfig.fileNames,
        options: tsconfig.options,
        projectReferences: tsconfig.projectReferences,
        host: compilerHost,
        configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(tsconfig)
      });
      tsProgram = builderProgram.getProgram();
    } else {
      tsProgram = ts.createProgram({
        rootNames: tsconfig.fileNames,
        options: tsconfig.options,
        projectReferences: tsconfig.projectReferences,
        host: compilerHost,
        configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(tsconfig)
      });
    }

    // Prefer the builder program, since it is what gives us incremental builds
    const genericProgram: TTypescript.BuilderProgram | TTypescript.Program = builderProgram || tsProgram;

    this._logReadPerformance(ts);
    //#endregion

    //#region ANALYSIS
    const { duration: diagnosticsDurationMs, diagnostics: preDiagnostics } = measureTsPerformance(
      'Analyze',
      () => {
        const rawDiagnostics: TTypescript.Diagnostic[] = [
          ...genericProgram.getConfigFileParsingDiagnostics(),
          ...genericProgram.getOptionsDiagnostics(),
          ...genericProgram.getSyntacticDiagnostics(),
          ...genericProgram.getGlobalDiagnostics(),
          ...genericProgram.getSemanticDiagnostics()
        ];
        return { diagnostics: rawDiagnostics };
      }
    );
    this._typescriptTerminal.writeVerboseLine(`Analyze: ${diagnosticsDurationMs}ms`);
    //#endregion

    //#region EMIT
    const emitResult: IExtendedEmitResult = this._emit(ts, tsconfig, genericProgram);
    //#endregion

    this._logEmitPerformance(ts);

    //#region FINAL_ANALYSIS
    // Need to ensure that we include emit diagnostics, since they might not be part of the other sets
    const rawDiagnostics: TTypescript.Diagnostic[] = [...preDiagnostics, ...emitResult.diagnostics];
    //#endregion

    //#region WRITE
    // Using async file system I/O for theoretically better peak performance
    // Also allows to run concurrently with linting
    const writePromise: Promise<{ duration: number }> = measureTsPerformanceAsync('Write', () =>
      Async.forEachAsync(
        emitResult.filesToWrite,
        async ({ filePath, data }: { filePath: string; data: string }) =>
          this._cachedFileSystem.writeFile(filePath, data, { ensureFolderExists: true }),
        { concurrency: this._configuration.maxWriteParallelism }
      )
    );
    //#endregion

    const [eslint, tslint] = await Promise.all([
      this._initESlintAsync(ts, measureTsPerformance, measureTsPerformanceAsync),
      this._initTSlintAsync(ts, measureTsPerformance, measureTsPerformanceAsync)
    ]);
    const lintPromises: Promise<LinterBase<unknown>>[] = [];

    const extendedProgram: IExtendedProgram = tsProgram as IExtendedProgram;
    //#region ESLINT
    if (eslint) {
      lintPromises.push(this._runESlintAsync(eslint, extendedProgram, emitResult.changedSourceFiles));
    }
    //#endregion

    //#region TSLINT
    if (tslint) {
      lintPromises.push(this._runTSlintAsync(tslint, extendedProgram, emitResult.changedSourceFiles));
    }
    //#endregion

    const { duration: writeDuration } = await writePromise;
    this._typescriptTerminal.writeVerboseLine(
      `I/O Write: ${writeDuration}ms (${emitResult.filesToWrite.length} files)`
    );

    // In non-watch mode, notify EmitCompletedCallbackManager once after we complete the compile step
    this._emitCompletedCallbackManager.callback();

    const linters: LinterBase<unknown>[] = await Promise.all(lintPromises);

    this._logDiagnostics(ts, rawDiagnostics, linters);
  }

  public async _runSolutionBuildAsync(
    ts: ExtendedTypeScript,
    measureTsPerformance: PerformanceMeasurer,
    measureTsPerformanceAsync: PerformanceMeasurerAsync
  ): Promise<void> {
    this._typescriptTerminal.writeVerboseLine(`Using solution mode`);

    const lintPromises: Promise<LinterBase<unknown>>[] = [];

    //#region CONFIGURE
    const {
      duration: configureDurationMs,
      rawDiagnostics,
      solutionBuilderHost
    } = await measureTsPerformanceAsync('Configure', async () => {
      this._overrideTypeScriptReadJson(ts);
      const _tsconfig: TTypescript.ParsedCommandLine = this._loadTsconfig(ts);
      this._validateTsconfig(ts, _tsconfig);

      const _rawDiagnostics: TTypescript.Diagnostic[] = [];
      const reportDiagnostic: TTypescript.DiagnosticReporter = (diagnostic: TTypescript.Diagnostic) => {
        _rawDiagnostics.push(diagnostic);
      };

      const [eslint, tslint] = await Promise.all([
        this._initESlintAsync(ts, measureTsPerformance, measureTsPerformanceAsync),
        this._initTSlintAsync(ts, measureTsPerformance, measureTsPerformanceAsync)
      ]);

      // TypeScript doesn't have a
      EmitFilesPatch.install(ts, _tsconfig, this._moduleKindsToEmit);

      const _solutionBuilderHost: TSolutionHost = this._buildSolutionBuilderHost(ts, reportDiagnostic);

      _solutionBuilderHost.afterProgramEmitAndDiagnostics = (
        program: TTypescript.EmitAndSemanticDiagnosticsBuilderProgram
      ) => {
        const tsProgram: TTypescript.Program | undefined = program.getProgram();

        if (tsProgram) {
          const extendedProgram: IExtendedProgram = tsProgram as IExtendedProgram;
          if (eslint) {
            lintPromises.push(this._runESlintAsync(eslint, extendedProgram));
          }

          if (tslint) {
            lintPromises.push(this._runTSlintAsync(tslint, extendedProgram));
          }
        }
      };

      return {
        rawDiagnostics: _rawDiagnostics,
        solutionBuilderHost: _solutionBuilderHost
      };
    });
    this._typescriptTerminal.writeVerboseLine(`Configure: ${configureDurationMs}ms`);
    //#endregion

    const solutionBuilder: TTypescript.SolutionBuilder<TTypescript.EmitAndSemanticDiagnosticsBuilderProgram> =
      ts.createSolutionBuilder(solutionBuilderHost, [this._configuration.tsconfigPath], {});

    //#region EMIT
    // Ignoring the exit status because we only care about presence of diagnostics
    solutionBuilder.build();
    //#endregion

    this._logReadPerformance(ts);
    this._logEmitPerformance(ts);
    // Use the native metric since we aren't overwriting the writer
    this._typescriptTerminal.writeVerboseLine(
      `I/O Write: ${ts.performance.getDuration('I/O Write')}ms (${ts.performance.getCount(
        'beforeIOWrite'
      )} files)`
    );

    // In non-watch mode, notify EmitCompletedCallbackManager once after we complete the compile step
    this._emitCompletedCallbackManager.callback();

    const linters: LinterBase<unknown>[] = await Promise.all(lintPromises);

    this._logDiagnostics(ts, rawDiagnostics, linters);

    EmitFilesPatch.uninstall(ts);
  }

  private _logDiagnostics(
    ts: ExtendedTypeScript,
    rawDiagnostics: readonly TTypescript.Diagnostic[],
    linters: LinterBase<unknown>[]
  ): void {
    const diagnostics: readonly TTypescript.Diagnostic[] = ts.sortAndDeduplicateDiagnostics(rawDiagnostics);

    let typeScriptErrorCount: number = 0;
    if (diagnostics.length > 0) {
      this._typescriptTerminal.writeLine(
        `Encountered ${diagnostics.length} TypeScript issue${diagnostics.length > 1 ? 's' : ''}:`
      );
      for (const diagnostic of diagnostics) {
        const diagnosticCategory: TTypescript.DiagnosticCategory = this._getAdjustedDiagnosticCategory(
          diagnostic,
          ts
        );

        if (diagnosticCategory === ts.DiagnosticCategory.Error) {
          typeScriptErrorCount++;
        }

        this._printDiagnosticMessage(ts, diagnostic, diagnosticCategory);
      }
    }

    for (const linter of linters) {
      linter.reportFailures();
    }

    if (typeScriptErrorCount > 0) {
      throw new Error(`Encountered TypeScript error${typeScriptErrorCount > 1 ? 's' : ''}`);
    }
  }

  private _logEmitPerformance(ts: ExtendedTypeScript): void {
    this._typescriptTerminal.writeVerboseLine(`Bind: ${ts.performance.getDuration('Bind')}ms`);
    this._typescriptTerminal.writeVerboseLine(`Check: ${ts.performance.getDuration('Check')}ms`);
    this._typescriptTerminal.writeVerboseLine(
      `Transform: ${ts.performance.getDuration('transformTime')}ms ` +
        `(${ts.performance.getCount('beforeTransform')} files)`
    );
    this._typescriptTerminal.writeVerboseLine(
      `Print: ${ts.performance.getDuration('printTime')}ms ` +
        `(${ts.performance.getCount('beforePrint')} files) (Includes Transform)`
    );
    this._typescriptTerminal.writeVerboseLine(
      `Emit: ${ts.performance.getDuration('Emit')}ms (Includes Print)`
    );
  }

  private _logReadPerformance(ts: ExtendedTypeScript): void {
    this._typescriptTerminal.writeVerboseLine(
      `I/O Read: ${ts.performance.getDuration('I/O Read')}ms (${ts.performance.getCount(
        'beforeIORead'
      )} files)`
    );
    this._typescriptTerminal.writeVerboseLine(
      `Parse: ${ts.performance.getDuration('Parse')}ms (${ts.performance.getCount('beforeParse')} files)`
    );
    this._typescriptTerminal.writeVerboseLine(
      `Program (includes Read + Parse): ${ts.performance.getDuration('Program')}ms`
    );
  }

  private async _initTSlintAsync(
    ts: ExtendedTypeScript,
    measureTsPerformance: PerformanceMeasurer,
    measureTsPerformanceAsync: PerformanceMeasurerAsync
  ): Promise<ILinterWrapper | undefined> {
    if (this._tslintEnabled) {
      if (!this._configuration.tslintToolPath) {
        throw new Error('Unable to resolve "tslint" package');
      }

      const logger: IScopedLogger = await this.requestScopedLoggerAsync('tslint');
      return {
        logger,
        ts,
        measureTsPerformance,
        measureTsPerformanceAsync
      };
    }
  }

  private async _initESlintAsync(
    ts: ExtendedTypeScript,
    measureTsPerformance: PerformanceMeasurer,
    measureTsPerformanceAsync: PerformanceMeasurerAsync
  ): Promise<ILinterWrapper | undefined> {
    if (this._eslintEnabled) {
      if (!this._configuration.eslintToolPath) {
        throw new Error('Unable to resolve "eslint" package');
      }

      const logger: IScopedLogger = await this.requestScopedLoggerAsync('eslint');
      return {
        logger,
        ts,
        measureTsPerformance,
        measureTsPerformanceAsync
      };
    }
  }

  private async _runESlintAsync(
    linter: ILinterWrapper,
    tsProgram: IExtendedProgram,
    changedFiles?: Set<IExtendedSourceFile> | undefined
  ): Promise<Eslint> {
    const eslint: Eslint = new Eslint({
      ts: linter.ts,
      scopedLogger: linter.logger,
      buildFolderPath: this._configuration.buildFolder,
      buildMetadataFolderPath: this._configuration.buildMetadataFolder,
      linterConfigFilePath: this._eslintConfigFilePath,
      measurePerformance: linter.measureTsPerformance,
      measurePerformanceAsync: linter.measureTsPerformanceAsync,
      eslintPackagePath: this._configuration.eslintToolPath!
    });

    eslint.printVersionHeader();

    const typeScriptFilenames: Set<string> = new Set(tsProgram.getRootFileNames());
    await eslint.performLintingAsync({
      tsProgram,
      typeScriptFilenames,
      changedFiles: changedFiles || new Set(tsProgram.getSourceFiles())
    });

    return eslint;
  }

  private async _runTSlintAsync(
    linter: ILinterWrapper,
    tsProgram: IExtendedProgram,
    changedFiles?: Set<IExtendedSourceFile> | undefined
  ): Promise<Tslint> {
    const tslint: Tslint = new Tslint({
      ts: linter.ts,
      scopedLogger: linter.logger,
      buildFolderPath: this._configuration.buildFolder,
      buildMetadataFolderPath: this._configuration.buildMetadataFolder,
      linterConfigFilePath: this._tslintConfigFilePath,
      measurePerformance: linter.measureTsPerformance,
      measurePerformanceAsync: linter.measureTsPerformanceAsync,
      cachedFileSystem: this._cachedFileSystem,
      tslintPackagePath: this._configuration.tslintToolPath!
    });

    tslint.printVersionHeader();

    const typeScriptFilenames: Set<string> = new Set(tsProgram.getRootFileNames());
    await tslint.performLintingAsync({
      tsProgram,
      typeScriptFilenames,
      changedFiles: changedFiles || new Set(tsProgram.getSourceFiles())
    });

    return tslint;
  }

  private _printDiagnosticMessage(
    ts: ExtendedTypeScript,
    diagnostic: TTypescript.Diagnostic,
    diagnosticCategory: TTypescript.DiagnosticCategory = this._getAdjustedDiagnosticCategory(diagnostic, ts)
  ): void {
    // Code taken from reference example
    let diagnosticMessage: string;
    let errorObject: Error;
    if (diagnostic.file) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
      const message: string = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      const formattedMessage: string = `(TS${diagnostic.code}) ${message}`;
      errorObject = new FileError(formattedMessage, {
        absolutePath: diagnostic.file.fileName,
        projectFolder: this._configuration.buildFolder,
        line: line + 1,
        column: character + 1
      });
      diagnosticMessage = errorObject.toString();
    } else {
      diagnosticMessage = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      errorObject = new Error(diagnosticMessage);
    }

    switch (diagnosticCategory) {
      case ts.DiagnosticCategory.Error: {
        this._typescriptLogger.emitError(errorObject);
        break;
      }

      case ts.DiagnosticCategory.Warning: {
        this._typescriptLogger.emitWarning(errorObject);
        break;
      }

      default: {
        this._typescriptTerminal.writeLine(...diagnosticMessage);
        break;
      }
    }
  }

  private _getAdjustedDiagnosticCategory(
    diagnostic: TTypescript.Diagnostic,
    ts: ExtendedTypeScript
  ): TTypescript.DiagnosticCategory {
    // Workaround for https://github.com/microsoft/TypeScript/issues/40058
    // The compiler reports a hard error for issues such as this:
    //
    //    error TS6133: 'x' is declared but its value is never read.
    //
    // These should properly be treated as warnings, because they are purely cosmetic issues.
    // TODO: Maybe heft should provide a config file for managing DiagnosticCategory mappings.
    if (diagnostic.reportsUnnecessary && diagnostic.category === ts.DiagnosticCategory.Error) {
      return ts.DiagnosticCategory.Warning;
    }

    // These pedantic checks also should not be treated as hard errors
    switch (diagnostic.code) {
      case ts.Diagnostics.Property_0_has_no_initializer_and_is_not_definitely_assigned_in_the_constructor
        .code:
      case ts.Diagnostics
        .Element_implicitly_has_an_any_type_because_expression_of_type_0_can_t_be_used_to_index_type_1.code:
        return ts.DiagnosticCategory.Warning;
    }

    return diagnostic.category;
  }

  private _emit(
    ts: ExtendedTypeScript,
    tsconfig: TTypescript.ParsedCommandLine,
    genericProgram: TTypescript.BuilderProgram | TTypescript.Program
  ): IExtendedEmitResult {
    const filesToWrite: IFileToWrite[] = [];

    const changedFiles: Set<IExtendedSourceFile> = new Set<IExtendedSourceFile>();
    EmitFilesPatch.install(ts, tsconfig, this._moduleKindsToEmit, changedFiles);

    const writeFileCallback: TTypescript.WriteFileCallback = (filePath: string, data: string) => {
      filesToWrite.push({ filePath, data });
    };

    const result: TTypescript.EmitResult = genericProgram.emit(
      undefined, // Target source file
      writeFileCallback
    );

    EmitFilesPatch.uninstall(ts);

    return {
      ...result,
      changedSourceFiles: changedFiles,
      filesToWrite
    };
  }

  private _validateTsconfig(ts: ExtendedTypeScript, tsconfig: TTypescript.ParsedCommandLine): void {
    if (
      (tsconfig.options.module && !tsconfig.options.outDir) ||
      (!tsconfig.options.module && tsconfig.options.outDir)
    ) {
      throw new Error(
        'If either the module or the outDir option is provided in the tsconfig compilerOptions, both must be provided'
      );
    }

    this._moduleKindsToEmit = [];
    const specifiedKinds: Map<TTypescript.ModuleKind, IModuleKindReason> = new Map();
    const specifiedOutDirs: Map<string, IModuleKindReason> = new Map();

    if (!tsconfig.options.module) {
      throw new Error(
        'If the module tsconfig compilerOption is not provided, the builder must be provided with the ' +
          'additionalModuleKindsToEmit configuration option.'
      );
    }

    if (this._configuration.emitCjsExtensionForCommonJS) {
      this._addModuleKindToEmit(
        ts.ModuleKind.CommonJS,
        tsconfig.options.outDir!,
        /* isPrimary */ tsconfig.options.module === ts.ModuleKind.CommonJS,
        '.cjs'
      );

      const cjsReason: IModuleKindReason = {
        outDir: tsconfig.options.outDir!,
        kind: 'CommonJS',
        extension: '.cjs',
        reason: 'emitCjsExtensionForCommonJS'
      };

      specifiedKinds.set(ts.ModuleKind.CommonJS, cjsReason);
      specifiedOutDirs.set(`${tsconfig.options.outDir!}:.cjs`, cjsReason);
    }

    if (this._configuration.emitMjsExtensionForESModule) {
      this._addModuleKindToEmit(
        ts.ModuleKind.ESNext,
        tsconfig.options.outDir!,
        /* isPrimary */ tsconfig.options.module === ts.ModuleKind.ESNext,
        '.mjs'
      );

      const mjsReason: IModuleKindReason = {
        outDir: tsconfig.options.outDir!,
        kind: 'ESNext',
        extension: '.mjs',
        reason: 'emitMjsExtensionForESModule'
      };

      specifiedKinds.set(ts.ModuleKind.ESNext, mjsReason);
      specifiedOutDirs.set(`${tsconfig.options.outDir!}:.mjs`, mjsReason);
    }

    if (!specifiedKinds.has(tsconfig.options.module)) {
      this._addModuleKindToEmit(
        tsconfig.options.module,
        tsconfig.options.outDir!,
        /* isPrimary */ true,
        /* jsExtensionOverride */ undefined
      );

      const tsConfigReason: IModuleKindReason = {
        outDir: tsconfig.options.outDir!,
        kind: ts.ModuleKind[tsconfig.options.module] as keyof typeof TTypescript.ModuleKind,
        extension: '.js',
        reason: 'tsconfig.json'
      };

      specifiedKinds.set(tsconfig.options.module, tsConfigReason);
      specifiedOutDirs.set(`${tsconfig.options.outDir!}:.js`, tsConfigReason);
    }

    if (this._configuration.additionalModuleKindsToEmit) {
      for (const additionalModuleKindToEmit of this._configuration.additionalModuleKindsToEmit) {
        const moduleKind: TTypescript.ModuleKind = this._parseModuleKind(
          ts,
          additionalModuleKindToEmit.moduleKind
        );

        const outDirKey: string = `${additionalModuleKindToEmit.outFolderName}:.js`;
        const moduleKindReason: IModuleKindReason = {
          kind: ts.ModuleKind[moduleKind] as keyof typeof TTypescript.ModuleKind,
          outDir: additionalModuleKindToEmit.outFolderName,
          extension: '.js',
          reason: `additionalModuleKindsToEmit`
        };

        const existingKind: IModuleKindReason | undefined = specifiedKinds.get(moduleKind);
        const existingDir: IModuleKindReason | undefined = specifiedOutDirs.get(outDirKey);

        if (existingKind) {
          throw new Error(
            `Module kind "${additionalModuleKindToEmit.moduleKind}" is already emitted at ${existingKind.outDir} with extension '${existingKind.extension}' by option ${existingKind.reason}.`
          );
        } else if (existingDir) {
          throw new Error(
            `Output folder "${additionalModuleKindToEmit.outFolderName}" already contains module kind ${existingDir.kind} with extension '${existingDir.extension}', specified by option ${existingDir.reason}.`
          );
        } else {
          const outFolderKey: string | undefined = this._addModuleKindToEmit(
            moduleKind,
            additionalModuleKindToEmit.outFolderName,
            /* isPrimary */ false,
            undefined
          );

          if (outFolderKey) {
            specifiedKinds.set(moduleKind, moduleKindReason);
            specifiedOutDirs.set(outFolderKey, moduleKindReason);
          }
        }
      }
    }
  }

  private _addModuleKindToEmit(
    moduleKind: TTypescript.ModuleKind,
    outFolderPath: string,
    isPrimary: boolean,
    jsExtensionOverride: string | undefined
  ): string | undefined {
    let outFolderName: string;
    if (path.isAbsolute(outFolderPath)) {
      outFolderName = path.relative(this._configuration.buildFolder, outFolderPath);
    } else {
      outFolderName = outFolderPath;
      outFolderPath = path.resolve(this._configuration.buildFolder, outFolderPath);
    }

    outFolderPath = Path.convertToSlashes(outFolderPath);
    outFolderPath = outFolderPath.replace(/\/*$/, '/'); // Ensure the outFolderPath ends with a slash

    for (const existingModuleKindToEmit of this._moduleKindsToEmit) {
      let errorText: string | undefined;

      if (existingModuleKindToEmit.outFolderPath === outFolderPath) {
        if (existingModuleKindToEmit.jsExtensionOverride === jsExtensionOverride) {
          errorText =
            'Unable to output two different module kinds with the same ' +
            `module extension (${jsExtensionOverride || '.js'}) to the same ` +
            `folder ("${outFolderPath}").`;
        }
      } else {
        let parentFolder: string | undefined;
        let childFolder: string | undefined;
        if (outFolderPath.startsWith(existingModuleKindToEmit.outFolderPath)) {
          parentFolder = outFolderPath;
          childFolder = existingModuleKindToEmit.outFolderPath;
        } else if (existingModuleKindToEmit.outFolderPath.startsWith(outFolderPath)) {
          parentFolder = existingModuleKindToEmit.outFolderPath;
          childFolder = outFolderPath;
        }

        if (parentFolder) {
          errorText =
            'Unable to output two different module kinds to nested folders ' +
            `("${parentFolder}" and "${childFolder}").`;
        }
      }

      if (errorText) {
        this._typescriptLogger.emitError(new Error(errorText));
        return undefined;
      }
    }

    this._moduleKindsToEmit.push({
      outFolderPath,
      moduleKind,
      jsExtensionOverride,

      isPrimary
    });

    return `${outFolderName}:${jsExtensionOverride || '.js'}`;
  }

  private _loadTsconfig(ts: ExtendedTypeScript): TTypescript.ParsedCommandLine {
    const parsedConfigFile: ReturnType<typeof ts.readConfigFile> = ts.readConfigFile(
      this._configuration.tsconfigPath,
      this._cachedFileSystem.readFile
    );

    const currentFolder: string = path.dirname(this._configuration.tsconfigPath);
    const tsconfig: TTypescript.ParsedCommandLine = ts.parseJsonConfigFileContent(
      parsedConfigFile.config,
      {
        fileExists: this._cachedFileSystem.exists,
        readFile: this._cachedFileSystem.readFile,
        readDirectory: (
          folderPath: string,
          extensions?: ReadonlyArray<string>,
          excludes?: ReadonlyArray<string>,
          includes?: ReadonlyArray<string>,
          depth?: number
        ) =>
          ts.matchFiles(
            folderPath,
            extensions,
            excludes,
            includes,
            /* useCaseSensitiveFileNames */ true,
            currentFolder,
            depth,
            this._cachedFileSystem.readFolderFilesAndDirectories.bind(this._cachedFileSystem),
            this._cachedFileSystem.getRealPath.bind(this._cachedFileSystem),
            this._cachedFileSystem.directoryExists.bind(this._cachedFileSystem)
          ),
        useCaseSensitiveFileNames: true
      },
      currentFolder,
      /*existingOptions:*/ undefined,
      this._configuration.tsconfigPath
    );

    if (tsconfig.options.incremental) {
      tsconfig.options.tsBuildInfoFile = this._tsCacheFilePath;
    }

    if (tsconfig.options.declaration && !tsconfig.options.declarationDir) {
      // Explicitly set the declarationDir for multi-emit tracking
      tsconfig.options.declarationDir = tsconfig.options.outDir;
    }

    return tsconfig;
  }

  private _buildSolutionBuilderHost(
    ts: ExtendedTypeScript,
    reportDiagnostic: TTypescript.DiagnosticReporter
  ): TSolutionHost {
    const reportSolutionBuilderStatus: TTypescript.DiagnosticReporter = reportDiagnostic;
    const reportEmitErrorSummary: TTypescript.ReportEmitErrorSummary = (errorCount: number): void => {
      // Do nothing
    };

    const compilerHost: TTypescript.SolutionBuilderHost<TTypescript.EmitAndSemanticDiagnosticsBuilderProgram> =
      ts.createSolutionBuilderHost(
        this._getCachingTypeScriptSystem(ts),
        ts.createEmitAndSemanticDiagnosticsBuilderProgram,
        reportDiagnostic,
        reportSolutionBuilderStatus,
        reportEmitErrorSummary
      );

    return compilerHost;
  }

  private _buildIncrementalCompilerHost(
    ts: ExtendedTypeScript,
    tsconfig: TTypescript.ParsedCommandLine
  ): TTypescript.CompilerHost {
    if (tsconfig.options.incremental) {
      return ts.createIncrementalCompilerHost(tsconfig.options, this._getCachingTypeScriptSystem(ts));
    } else {
      return ts.createCompilerHost(tsconfig.options);
    }
  }

  private _getCachingTypeScriptSystem(ts: ExtendedTypeScript): TTypescript.System {
    const sys: TTypescript.System = {
      ...ts.sys,
      deleteFile: this._cachedFileSystem.deleteFile.bind(this._cachedFileSystem),
      /** Check if the path exists and is a directory */
      directoryExists: (directoryPath: string) => {
        try {
          const stats: FileSystemStats = this._cachedFileSystem.getStatistics(directoryPath);
          return stats.isDirectory() || stats.isSymbolicLink();
        } catch (error) {
          if (FileSystem.isNotExistError(error as Error)) {
            return false;
          } else {
            throw error;
          }
        }
      },
      /** Check if the path exists and is a file */
      fileExists: (filePath: string) => {
        try {
          const stats: FileSystemStats = this._cachedFileSystem.getStatistics(filePath);
          return stats.isFile();
        } catch (error) {
          if (FileSystem.isNotExistError(error as Error)) {
            return false;
          } else {
            throw error;
          }
        }
      },
      /* Use the Heft config's build folder because it has corrected casing */
      getCurrentDirectory: () => this._configuration.buildFolder,
      getDirectories: (folderPath: string) => {
        return this._cachedFileSystem.readFolderFilesAndDirectories(folderPath).directories;
      },
      realpath: this._cachedFileSystem.getRealPath.bind(this._cachedFileSystem)
    };

    return sys;
  }

  private _buildWatchCompilerHost(
    ts: ExtendedTypeScript,
    tsconfig: TTypescript.ParsedCommandLine
  ): TWatchCompilerHost {
    const reportDiagnostic: TTypescript.DiagnosticReporter = (diagnostic: TTypescript.Diagnostic): void => {
      this._printDiagnosticMessage(ts, diagnostic);
    };
    const reportWatchStatus: TTypescript.DiagnosticReporter = (diagnostic: TTypescript.Diagnostic) => {
      this._printDiagnosticMessage(ts, diagnostic);

      // In watch mode, notify EmitCompletedCallbackManager every time we finish recompiling.
      if (
        diagnostic.code === ts.Diagnostics.Found_0_errors_Watching_for_file_changes.code ||
        diagnostic.code === ts.Diagnostics.Found_1_error_Watching_for_file_changes.code
      ) {
        this._emitCompletedCallbackManager.callback();
      }
    };

    return ts.createWatchCompilerHost(
      tsconfig.fileNames,
      tsconfig.options,
      this._getCachingTypeScriptSystem(ts),
      ts.createEmitAndSemanticDiagnosticsBuilderProgram,
      reportDiagnostic,
      reportWatchStatus,
      tsconfig.projectReferences
    );
  }

  private _buildWatchSolutionBuilderHost(ts: ExtendedTypeScript): TWatchSolutionHost {
    const reportDiagnostic: TTypescript.DiagnosticReporter = (diagnostic: TTypescript.Diagnostic): void => {
      this._printDiagnosticMessage(ts, diagnostic);
    };
    const reportSolutionBuilderStatus: TTypescript.DiagnosticReporter = reportDiagnostic;
    const reportWatchStatus: TTypescript.DiagnosticReporter = (diagnostic: TTypescript.Diagnostic) => {
      this._printDiagnosticMessage(ts, diagnostic);

      // In watch mode, notify EmitCompletedCallbackManager every time we finish recompiling.
      if (
        diagnostic.code === ts.Diagnostics.Found_0_errors_Watching_for_file_changes.code ||
        diagnostic.code === ts.Diagnostics.Found_1_error_Watching_for_file_changes.code
      ) {
        this._emitCompletedCallbackManager.callback();
      }
    };

    return ts.createSolutionBuilderWithWatchHost(
      this._getCachingTypeScriptSystem(ts),
      ts.createEmitAndSemanticDiagnosticsBuilderProgram,
      reportDiagnostic,
      reportSolutionBuilderStatus,
      reportWatchStatus
    );
  }

  private _overrideTypeScriptReadJson(ts: ExtendedTypeScript): void {
    ts.readJson = (filePath: string) => {
      let jsonData: object | undefined = this._tsReadJsonCache.get(filePath);
      if (jsonData) {
        return jsonData;
      } else {
        try {
          const fileContents: string = this._cachedFileSystem.readFile(filePath);
          if (!fileContents) {
            jsonData = EMPTY_JSON;
          } else {
            const parsedFile: ReturnType<typeof ts.parseConfigFileTextToJson> = ts.parseConfigFileTextToJson(
              filePath,
              fileContents
            );
            if (parsedFile.error) {
              jsonData = EMPTY_JSON;
            } else {
              jsonData = parsedFile.config as object;
            }
          }
        } catch (error) {
          jsonData = EMPTY_JSON;
        }

        this._tsReadJsonCache.set(filePath, jsonData);
        return jsonData;
      }
    };
  }

  private _parseModuleKind(ts: ExtendedTypeScript, moduleKindName: string): TTypescript.ModuleKind {
    switch (moduleKindName.toLowerCase()) {
      case 'commonjs':
        return ts.ModuleKind.CommonJS;

      case 'amd':
        return ts.ModuleKind.AMD;

      case 'umd':
        return ts.ModuleKind.UMD;

      case 'system':
        return ts.ModuleKind.System;

      case 'es2015':
        return ts.ModuleKind.ES2015;

      case 'esnext':
        return ts.ModuleKind.ESNext;

      default:
        throw new Error(`"${moduleKindName}" is not a valid module kind name.`);
    }
  }
}
