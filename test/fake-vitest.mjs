#!/usr/bin/env node
// A tiny stand-in for Vitest: fake-jest.mjs with Vitest's flags and output (see there).
globalThis.fakeVitest = true;
await import('./fake-jest.mjs');
