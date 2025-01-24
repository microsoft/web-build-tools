## Overview
This plugin is used to create json files representing the build graph of a rush action. When used, it only runs through the process of generating Rush's version of the graph, which is then processed and dropped as a file before exiting the process.

## Usage
The plugin is invoked via the `--drop-graph [file]` parameter to rush, which says to run the command as otherwise given, but to drop the graph to the given file and exit before executing the build tasks. The graph is represented as a json object which can be seen under `examples/graph.json`.

## Limitations
It currently only supports shell operations, which is to say that the only supported runner to be passed in from Rush is the ShellOperationRunner.