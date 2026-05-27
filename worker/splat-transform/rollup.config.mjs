import { execSync } from 'node:child_process';

import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import typescript from '@rollup/plugin-typescript';

import pkg from './package.json' with { type: 'json' };

const revision = (() => {
    try {
        return execSync('git rev-parse --short HEAD').toString().trim();
    } catch (e) {
        return 'unknown';
    }
})();

const versionReplace = () => replace({
    preventAssignment: true,
    values: {
        $_CURRENT_VERSION: pkg.version,
        $_CURRENT_REVISION: revision
    }
});

// CLI build - Node.js specific. `webgpu` is external and only loaded when a
// GPU device is requested, so CPU-only conversion needs no native deps.
const cli = {
    input: 'src/cli/index.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true,
        entryFileNames: 'cli.mjs'
    },
    external: ['webgpu'],
    plugins: [
        versionReplace(),
        typescript({
            tsconfig: './tsconfig.json',
            declaration: false,
            declarationDir: undefined
        }),
        resolve(),
        json()
    ],
    cache: false
};

export default [cli];
