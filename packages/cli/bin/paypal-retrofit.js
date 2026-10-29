#!/usr/bin/env node
// Runs the TypeScript sources directly through tsx, so the CLI works from a fresh clone without a build step.
import { register } from 'tsx/esm/api';

register();
await import('../src/index.ts');
