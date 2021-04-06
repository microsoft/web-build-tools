// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { FileWriter } from '@rushstack/node-core-library';

import { HeftConfiguration } from '../configuration/HeftConfiguration';
import { IHeftPlugin } from '../pluginFramework/IHeftPlugin';
import { HeftSession } from '../pluginFramework/HeftSession';
import { IHeftLifecycle } from '../pluginFramework/HeftLifecycle';
import { HookInterceptor, SyncHook, Tap, TapOptions } from 'tapable';
import { IBuildStageContext } from '../stages/BuildStage';
import { ITestStageContext } from '../stages/TestStage';
import { ICleanStageContext } from '../stages/CleanStage';

const PLUGIN_NAME: 'TimelineTracePlugin' = 'TimelineTracePlugin';

/**
 * This plugin generates a timeline trace of the Heft execution in the Chrome Trace Events format.
 */
export class TimelineTracePlugin implements IHeftPlugin {
  public readonly pluginName: 'TimelineTracePlugin' = PLUGIN_NAME;

  public apply(heftSession: HeftSession, heftConfiguration: HeftConfiguration): void {
    const traceFileName: string = `${heftConfiguration.buildFolder}/heft.trace.${Date.now()}.json`;
    const writer: FileWriter = FileWriter.open(traceFileName);
    writer.write(
      `[${JSON.stringify({
        args: {
          name: 'Heft'
        },
        cat: '__metadata',
        name: 'thread_name',
        tid: 0,
        ph: 'M',
        pid: process.pid,
        ts: 0
      })}`
    );

    const now: bigint = process.hrtime.bigint();
    const start: bigint = now - BigInt(process.uptime() * 1e6);

    const nanoToMicro: bigint = BigInt(1e3);

    function asTimestamp(time: bigint): number {
      return Number(time / nanoToMicro);
    }

    function logCompleteEvent(name: string, startTimeNs: bigint, endTimeNs: bigint): void {
      writer.write(
        `,\n${JSON.stringify({
          cat: 'devtools.timeline',
          name,
          tid: 0,
          ph: 'X',
          pid: process.pid,
          ts: asTimestamp(startTimeNs),
          dur: asTimestamp(endTimeNs - startTimeNs)
        })}`
      );
    }

    logCompleteEvent('boot', start, now);

    // Ensure that the log file is complete.
    process.on('exit', () => {
      writer.write(']');
      writer.close();
    });

    function createInterceptor(context: string): HookInterceptor {
      return {
        register: (tap: Tap): Tap => {
          if (tap.name === PLUGIN_NAME) {
            // Avoid intercepting the interceptor
            return tap;
          }

          // eslint-disable-next-line @typescript-eslint/ban-types
          const innerFunction: Function = tap.fn;
          const name: string = `${context}.${tap.name}`;

          switch (tap.type) {
            case 'sync':
              return {
                ...tap,
                fn: function syncInterceptor(...args: unknown[]): unknown {
                  const startTimeNs: bigint = process.hrtime.bigint();
                  try {
                    return innerFunction.apply(this, args);
                  } finally {
                    logCompleteEvent(name, startTimeNs, process.hrtime.bigint());
                  }
                }
              };
            case 'async':
              return {
                ...tap,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                fn: function asyncInterceptor(...args: any[]): any {
                  const startTimeNs: bigint = process.hrtime.bigint();
                  const callback: (err: unknown, result: unknown) => void = args.pop();
                  args.push((err: unknown, result: unknown): void => {
                    logCompleteEvent(name, startTimeNs, process.hrtime.bigint());
                    callback(err, result);
                  });

                  return innerFunction.apply(this, args);
                }
              };
            case 'promise':
              return {
                ...tap,
                fn: function promiseInterceptor(...args: unknown[]): Promise<unknown> {
                  const startTimeNs: bigint = process.hrtime.bigint();
                  return innerFunction.apply(this, args).then(
                    (result: unknown) => {
                      logCompleteEvent(name, startTimeNs, process.hrtime.bigint());
                      return result;
                    },
                    (err: Error) => {
                      logCompleteEvent(name, startTimeNs, process.hrtime.bigint());
                      return Promise.reject(err);
                    }
                  );
                }
              };
            default:
              throw new Error(`Unknown tap type ${tap.type}`);
          }
        }
      };
    }

    const interceptorStageOptions: TapOptions<'sync'> = {
      name: PLUGIN_NAME,
      stage: -Infinity
    };

    function applyInterceptors(context: string, hooks: object): void {
      for (const [name, hook] of Object.entries(hooks)) {
        if (hook && typeof hook.intercept === 'function') {
          hook.intercept(createInterceptor(`${context}.${name}`));
        }
      }
    }

    function applySubstageInterceptors<K extends string>(
      context: string,
      stage: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hooks: { [P in K]: SyncHook<any> };
      },
      keys: K[]
    ): void {
      for (const key of keys) {
        stage.hooks[key].tap(interceptorStageOptions, (substage: { hooks: object }) => {
          applyInterceptors(`${context}.${key}`, substage.hooks);
        });
      }
    }

    heftSession.hooks.heftLifecycle.tap(interceptorStageOptions, (heftLifecycle: IHeftLifecycle) => {
      applyInterceptors('heftSession.heftLifecycle', heftLifecycle.hooks);
    });

    heftSession.hooks.build.tap(interceptorStageOptions, (buildStage: IBuildStageContext) => {
      applySubstageInterceptors('heftSession.build', buildStage, [
        'preCompile',
        'compile',
        'bundle',
        'postBuild'
      ]);
      applyInterceptors('heftSession.build', buildStage.hooks);
    });

    heftSession.hooks.clean.tap(interceptorStageOptions, (cleanStage: ICleanStageContext) => {
      applyInterceptors('heftSession.clean', cleanStage.hooks);
    });

    heftSession.hooks.test.tap(interceptorStageOptions, (testStage: ITestStageContext) => {
      applyInterceptors('heftSession.test', testStage.hooks);
    });

    applyInterceptors('heftSession.metricsCollector', heftSession.hooks.metricsCollector);
    applyInterceptors('heftSession', heftSession.hooks);
  }
}
