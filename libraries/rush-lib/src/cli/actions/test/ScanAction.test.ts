// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.
import '../../test/mockRushCommandLineParser';

import '../../test/mockRushCommandLineParser';
import { ScanAction } from '../ScanAction';
import { RushCommandLineParser } from '../../RushCommandLineParser';

import { Terminal } from '@rushstack/terminal';

describe.skip(ScanAction.name, () => {
  describe('basic "rush remove" tests', () => {
    let terminalMock: jest.SpyInstance;
    let oldExitCode: number | undefined;
    let oldArgs: string[];

    beforeEach(() => {
      terminalMock = jest.spyOn(Terminal.prototype, 'write').mockImplementation(() => {});

      jest.spyOn(process, 'exit').mockImplementation();

      oldExitCode = process.exitCode;
      oldArgs = process.argv;
    });

    afterEach(() => {
      jest.clearAllMocks();
      process.exitCode = oldExitCode;
      process.argv = oldArgs;
    });

    describe("'scan' action", () => {
      it(`scan the repository to find phantom dependencies. `, async () => {
        const aPath: string = `${__dirname}/scanRepo/a`;

        const parser: RushCommandLineParser = new RushCommandLineParser({ cwd: aPath });

        jest.spyOn(process, 'cwd').mockReturnValue(aPath);

        process.argv = ['pretend-this-is-node.exe', 'pretend-this-is-rush', 'scan', '--json'];
        await expect(parser.executeAsync()).resolves.toEqual(true);
        expect(terminalMock).toHaveBeenCalledTimes(1);
      });
    });
  });
});
