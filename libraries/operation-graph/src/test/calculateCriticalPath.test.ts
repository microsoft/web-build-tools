// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  calculateShortestPath,
  calculateCriticalPathLength,
  calculateCriticalPathLengths,
  type ISortableOperation
} from '../calculateCriticalPath';

interface ITestOperation extends ISortableOperation<ITestOperation> {
  // Nothing added, just need an interface to solve the infinite expansion.
}

function createGraph(
  edges: Iterable<[start: string, end: string]>,
  weights?: Iterable<[name: string, weight: number]>
): Map<string, ITestOperation> {
  const nodes: Map<string, ITestOperation> = new Map();
  if (weights) {
    for (const [name, weight] of weights) {
      nodes.set(name, {
        operationName: name,
        weight,
        consumers: new Set()
      });
    }
  }

  function getOrCreateNode(name: string): ITestOperation {
    let node: ITestOperation | undefined = nodes.get(name);
    if (!node) {
      node = {
        operationName: name,
        weight: 1,
        consumers: new Set()
      };
      nodes.set(name, node);
    }
    return node;
  }

  for (const [start, end] of edges) {
    const startNode: ITestOperation = getOrCreateNode(start);
    const endNode: ITestOperation = getOrCreateNode(end);
    endNode.consumers.add(startNode);
  }

  return nodes;
}

describe(calculateShortestPath.name, () => {
  it('returns the shortest path', () => {
    const graph: Map<string, ITestOperation> = createGraph([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
      ['e', 'f']
    ]);

    const result1: ITestOperation[] = calculateShortestPath(graph.get('a')!, graph.get('f')!);
    expect(result1.map((x) => x.operationName)).toMatchSnapshot('long');

    graph.get('c')!.consumers.add(graph.get('a')!);

    const result2: ITestOperation[] = calculateShortestPath(graph.get('a')!, graph.get('f')!);
    expect(result2.map((x) => x.operationName)).toMatchSnapshot('with shortcut');

    graph.get('f')!.consumers.add(graph.get('c')!);

    const result3: ITestOperation[] = calculateShortestPath(graph.get('a')!, graph.get('f')!);
    expect(result3.map((x) => x.operationName)).toMatchSnapshot('with multiple shortcuts');

    graph.get('a')!.consumers.add(graph.get('f')!);

    const result4: ITestOperation[] = calculateShortestPath(graph.get('a')!, graph.get('a')!);
    expect(result4.map((x) => x.operationName)).toMatchSnapshot('with multiple shortcuts (circular)');
  });
});

describe(calculateCriticalPathLength.name, () => {
  it('sets the critical path', () => {
    const graph1: Map<string, ITestOperation> = createGraph(
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
        ['d', 'e'],
        ['e', 'f'],
        ['c', 'g']
      ],
      Object.entries({
        a: 1,
        b: 1,
        c: 1,
        d: 1,
        e: 1,
        f: 1,
        g: 10
      })
    );

    const lengths: Record<string, number> = {};

    for (const [name, node] of graph1) {
      const criticalPathLength: number = calculateCriticalPathLength(node, new Set());
      lengths[name] = criticalPathLength;
    }
    expect(lengths).toMatchSnapshot();
  });

  it('reports circularities', () => {
    const graph1: Map<string, ITestOperation> = createGraph([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'b'],
      ['c', 'd'],
      ['d', 'e']
    ]);

    expect(() => {
      calculateCriticalPathLength(graph1.get('e')!, new Set());
    }).toThrowErrorMatchingSnapshot();
  });
});

describe(calculateCriticalPathLengths.name, () => {
  it('sets the critical path', () => {
    const graph1: Map<string, ITestOperation> = createGraph(
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
        ['d', 'e'],
        ['e', 'f'],
        ['c', 'g']
      ],
      Object.entries({
        a: 1,
        b: 1,
        c: 1,
        d: 1,
        e: 1,
        f: 1,
        g: 10
      })
    );

    calculateCriticalPathLengths(graph1.values());

    const lengths: Record<string, number | undefined> = {};

    for (const [name, node] of graph1) {
      lengths[name] = node.criticalPathLength;
    }
    expect(lengths).toMatchSnapshot();
  });
});
