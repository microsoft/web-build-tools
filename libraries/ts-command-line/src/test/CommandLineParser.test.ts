// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { CommandLineAction } from '../providers/CommandLineAction';
import type { CommandLineFlagParameter } from '../parameters/CommandLineFlagParameter';
import { CommandLineParser } from '../providers/CommandLineParser';

class TestAction extends CommandLineAction {
  public done: boolean = false;
  private _flag: CommandLineFlagParameter;
  private _anotherFlag: CommandLineFlagParameter;

  public constructor() {
    super({
      actionName: 'do:the-job',
      summary: 'does the job',
      documentation: 'a longer description'
    });

    this._flag = this.defineFlagParameter({
      parameterLongName: '--flag',
      description: 'The flag'
    });

    this._anotherFlag = this.defineFlagParameter({
      parameterLongName: '--another-flag',
      description: 'Another flag'
    });
  }

  protected async onExecute(): Promise<void> {
    expect(this._flag.value).toEqual(true);
    this.done = true;
  }
}

class TestCommandLine extends CommandLineParser {
  public constructor() {
    super({
      toolFilename: 'example',
      toolDescription: 'An example project'
    });

    this.addAction(new TestAction());
  }

  protected onDefineParameters(): void {
    // no parameters
  }
}

describe(CommandLineParser.name, () => {
  it('executes an action', async () => {
    const commandLineParser: TestCommandLine = new TestCommandLine();
    commandLineParser._registerDefinedParameters();

    await commandLineParser.execute(['do:the-job', '--flag']);

    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('do:the-job');

    const action: TestAction = commandLineParser.selectedAction as TestAction;
    expect(action.done).toBe(true);
  });

  it('throws an error if an abbreviated parameter is provided', async () => {
    const commandLineParser: TestCommandLine = new TestCommandLine();
    commandLineParser._registerDefinedParameters();

    await expect(
      commandLineParser.executeWithoutErrorHandling(['do:the-job', '--flag', '--another'])
    ).rejects.toThrowError(/unrecognized arguments: --another/);
  });
});
