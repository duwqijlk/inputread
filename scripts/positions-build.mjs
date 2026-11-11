#!/usr/bin/env node
import { runPositionCli } from "./lib/position-mapping-tools.mjs";
process.exitCode = await runPositionCli("build");
