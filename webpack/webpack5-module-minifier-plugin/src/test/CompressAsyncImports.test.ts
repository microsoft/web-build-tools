// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

jest.disableAutomock();

import { promisify } from 'util';
import { Volume } from 'memfs/lib/volume';
import webpack, { type Stats } from 'webpack';
import { ModuleMinifierPlugin } from '../ModuleMinifierPlugin';
import type { IModuleMinifier } from '@rushstack/module-minifier';
import { MockMinifier } from './MockMinifier';
import exp from 'constants';

const MEMORY_FILE_SYSTEM: Volume = Volume.fromJSON({
  '/package.json': '{}',
  '/entry.js': `// A comment\nconsole.log("Do stuff");import(/* webpackChunkName: 'async' */ './async.js').then(mod => mod.foo());`,
  '/entry2.js': `Promise.all([import("./a"), import("./c"), import("./e")]).then(
    ([a, c, e]) => {
      console.log(a, c, e);
    }
  );`,
  '/entry3.js': `Promise.all([import("./g"), import("./h"), import("./i"), import("./j")]).then(
    ([g, h, i, j]) => {
      console.log(g, h, i, j);
    }
  );`,
  '/async.js':
    '// @license MIT\nimport bar from "./bar";\nimport baz from "./baz";\nexport function foo() { bar.a(); baz.b(); }console.log("Test character lengths: \ufeff\uffef")',
  '/a.js': `const b = import('./b').then(mod => mod.b); console.log(b);`,
  '/b.js': `export const b = 'b';`,
  '/c.js': `const d = import('./d').then(mod => mod.d); console.log(d);`,
  '/d.js': `export const d = 'd';`,
  '/e.js': `const f = import('./f').then(mod => mod.f); console.log(f);`,
  '/f.js': `export const f = 'f';`,
  '/g.js': `export default 'g';`,
  '/h.js': `import g from './g'; export default g;`,
  '/i.js': `import h from './h'; export default h;`,
  '/j.js': `import i from './i'; export default i;`,
  '/bar.js': `export default { a() { console.log('a'); } };`,
  '/baz.js': `export default { b() { console.log('b'); } };`
});

function getDefaultConfig(minifier: IModuleMinifier): webpack.Configuration {
  return {
    entry: {
      one: '/entry.js',
      two: '/entry2.js',
      three: '/entry3.js'
    },
    output: {
      path: '/release',
      filename: '[name].js'
    },
    optimization: {
      minimizer: []
    },
    context: '/',
    mode: 'production',
    plugins: [new ModuleMinifierPlugin({ minifier, compressAsyncImports: true })]
  };
}

async function runWebpack(): Promise<void> {
  const compiler: webpack.Compiler = webpack(getDefaultConfig(new MockMinifier()));

  compiler.inputFileSystem = MEMORY_FILE_SYSTEM;
  compiler.outputFileSystem = MEMORY_FILE_SYSTEM;

  const stats: Stats | undefined = await promisify(compiler.run.bind(compiler))();
  await promisify(compiler.close.bind(compiler))();

  if (!stats) {
    throw new Error('No stats');
  }

  const { errors, warnings } = stats.toJson('errors-warnings');
  expect(errors).toMatchSnapshot('Errors');
  expect(warnings).toMatchSnapshot('Warnings');

  const results: {} = MEMORY_FILE_SYSTEM.toJSON('/release');
  expect(results).toMatchSnapshot('Content');
}

describe(ModuleMinifierPlugin.name, () => {
  it('Correctly compresses async import callsites', async () => {
    await runWebpack();
  });
});
