import path from 'path';
import { findEslintLibraryLocation } from './global-suppressions-patch';
import { Linter as LinterPatch } from './linter-patch';

const eslintLibraryLocation = findEslintLibraryLocation();
const pathToLinterJs = path.join(eslintLibraryLocation, 'lib/linter/linter.js');
const { Linter } = require(pathToLinterJs);

Linter.prototype._conditionallyReinitialize = LinterPatch.prototype._conditionallyReinitialize;
Linter.prototype.constructor = LinterPatch.prototype.constructor;
Object.defineProperty(
  Linter,
  'version',
  Object.getOwnPropertyDescriptor(LinterPatch, 'version') as PropertyDescriptor
);
Linter.prototype._verifyWithoutProcessors = LinterPatch.prototype._verifyWithoutProcessors;
Linter.prototype.verify = LinterPatch.prototype.verify;
Linter.prototype._verifyWithFlatConfigArrayAndProcessor =
  LinterPatch.prototype._verifyWithFlatConfigArrayAndProcessor;
Linter.prototype._verifyWithFlatConfigArrayAndWithoutProcessors =
  LinterPatch.prototype._verifyWithFlatConfigArrayAndWithoutProcessors;
Linter.prototype._verifyWithConfigArray = LinterPatch.prototype._verifyWithConfigArray;
Linter.prototype._verifyWithFlatConfigArray = LinterPatch.prototype._verifyWithFlatConfigArray;
Linter.prototype._verifyWithProcessor = LinterPatch.prototype._verifyWithProcessor;
Linter.prototype._distinguishSuppressedMessages = LinterPatch.prototype._distinguishSuppressedMessages;
Linter.prototype.getSourceCode = LinterPatch.prototype.getSourceCode;
Linter.prototype.getSuppressedMessages = LinterPatch.prototype.getSuppressedMessages;
Linter.prototype.defineRule = LinterPatch.prototype.defineRule;
Linter.prototype.defineRules = LinterPatch.prototype.defineRules;
Linter.prototype.getRules = LinterPatch.prototype.getRules;
Linter.prototype.defineParser = LinterPatch.prototype.defineParser;
Linter.prototype.verifyAndFix = LinterPatch.prototype.verifyAndFix;