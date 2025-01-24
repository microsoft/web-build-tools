// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

// We're using a path-based import here to minimize the amount of code that is evaluated before
// we check to see if the Node.js version is too old. If, for whatever reason, Rush crashes with
// an old Node.js version when evaluating one of the more complex imports, we'll at least
// shown a meaningful error message.
import { NodeJsCompatibility } from '@microsoft/rush-lib/lib/logic/NodeJsCompatibility';

if (NodeJsCompatibility.reportAncientIncompatibleVersion()) {
  // The Node.js version is known to have serious incompatibilities.  In that situation, the user
  // should downgrade Rush to an older release that supported their Node.js version.
  process.exit(1);
}

const alreadyReportedNodeTooNewError: boolean = NodeJsCompatibility.warnAboutVersionTooNew({
  isRushLib: false,
  alreadyReportedNodeTooNewError: false
});

import * as os from 'os';
import * as semver from 'semver';

import { Text, PackageJsonLookup, type IPackageJson } from '@rushstack/node-core-library';
import { PrintUtilities, Colorize, ConsoleTerminalProvider, type ITerminalProvider, Terminal } from '@rushstack/terminal';
import { EnvironmentVariableNames } from '@microsoft/rush-lib';
import * as rushLib from '@microsoft/rush-lib';

import { RushCommandSelector } from './RushCommandSelector';
import { RushVersionSelector } from './RushVersionSelector';
import { MinimalRushConfiguration } from './MinimalRushConfiguration';

const terminalProvider: ITerminalProvider = new ConsoleTerminalProvider();

const terminal: Terminal = new Terminal(terminalProvider);

// Load the configuration
const configuration: MinimalRushConfiguration | undefined =
  MinimalRushConfiguration.loadFromDefaultLocation();

const currentPackageVersion: string = PackageJsonLookup.loadOwnPackageJson(__dirname).version;

let rushVersionToLoadInfo: {
  version: string;
  path?: string;
} | undefined = undefined;

const overridePath: string | undefined = process.env[EnvironmentVariableNames.RUSH_OVERRIDE_PATH];

const previewVersion: string | undefined = process.env[EnvironmentVariableNames.RUSH_PREVIEW_VERSION];

if (overridePath) {
  const overridePackageJson: IPackageJson | undefined = PackageJsonLookup.instance.tryLoadPackageJsonFor(overridePath);

  if (overridePackageJson === undefined) {
    terminal.writeErrorLine(`Cannot use version specified with "RUSH_OVERRIDE_PATH" environment variable as it doesn't point to valid Rush package: ${overridePath}`);
    process.exit(1);
  }

  const overrideVersion: string = overridePackageJson.version;

  // If we are overriding with an older Rush that doesn't understand the RUSH_OVERRIDE_PATH variable,
  // then unset it.
  if (semver.lt(overrideVersion, '5.141.0')) {
    delete process.env[EnvironmentVariableNames.RUSH_OVERRIDE_PATH];
  }

  PrintUtilities.printMessageInBox(
    [
      `WARNING! THE "RUSH_OVERRIDE_PATH" ENVIRONMENT VARIABLE IS SET.`,
      ``,
      `You are using Rush@${overrideVersion} from ${overridePath}`,
      ``,
      ...(
        configuration
          ? [
            `The rush.json configuration asks for: @${configuration.rushVersion}`,
            ``,
          ]
          : []
        ),
      `To restore the normal behavior, unset the "RUSH_OVERRIDE_PATH" environment variable.`,
    ].join(os.EOL),
    terminal,
  );

  rushVersionToLoadInfo = {
    version: overrideVersion,
    path: overridePath,
  };
} else if (previewVersion) {
  if (!semver.valid(previewVersion, false)) {
    console.error(
      Colorize.red(`Invalid value for RUSH_PREVIEW_VERSION environment variable: "${previewVersion}"`)
    );
    process.exit(1);
  }

  // If we are previewing an older Rush that doesn't understand the RUSH_PREVIEW_VERSION variable,
  // then unset it.
  if (semver.lt(previewVersion, '5.0.0-dev.18')) {
    delete process.env[EnvironmentVariableNames.RUSH_PREVIEW_VERSION];
  }

  rushVersionToLoadInfo = {
    version: previewVersion,
  };

  const lines: string[] = [];
  lines.push(
    `*********************************************************************`,
    `* WARNING! THE "RUSH_PREVIEW_VERSION" ENVIRONMENT VARIABLE IS SET.  *`,
    `*                                                                   *`,
    `* You are previewing Rush version:        ${Text.padEnd(previewVersion, 25)} *`
  );

  if (configuration) {
    lines.push(`* The rush.json configuration asks for:   ${Text.padEnd(configuration.rushVersion, 25)} *`);
  }

  lines.push(
    `*                                                                   *`,
    `* To restore the normal behavior, unset the RUSH_PREVIEW_VERSION    *`,
    `* environment variable.                                             *`,
    `*********************************************************************`
  );

  console.error(lines.map((line) => Colorize.black(Colorize.yellowBackground(line))).join(os.EOL));
} else if (configuration) {
  rushVersionToLoadInfo = {
    version: configuration.rushVersion,
  };
}

// Rush is "managed" if its version and configuration are dictated by a repo's rush.json
const isManaged: boolean = !!configuration;

const launchOptions: rushLib.ILaunchOptions = { isManaged, alreadyReportedNodeTooNewError, terminalProvider };

// If we're inside a repo folder, and it's requesting a different version, then use the RushVersionManager to
// install it
if (rushVersionToLoadInfo && (rushVersionToLoadInfo.version !== currentPackageVersion || rushVersionToLoadInfo.path !== undefined)) {
  const versionSelector: RushVersionSelector = new RushVersionSelector(currentPackageVersion);
  versionSelector
    .ensureRushVersionInstalledAsync(rushVersionToLoadInfo.version, rushVersionToLoadInfo.path, configuration, launchOptions)
    .catch((error: Error) => {
      console.log(Colorize.red('Error: ' + error.message));
    });
} else {
  // Otherwise invoke the rush-lib that came with this rush package
  RushCommandSelector.execute(currentPackageVersion, rushLib, launchOptions);
}
