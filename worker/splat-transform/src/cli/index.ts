import { lstat, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process, { exit } from 'node:process';
import { parseArgs } from 'node:util';

import type { GraphicsDevice } from 'playcanvas';

import { NodeFileSystem, NodeReadFileSystem } from './node-file-system';
import {
    DataTable,
    fmtBytes,
    fmtCount,
    fmtTime,
    getInputFormat,
    getSHBands,
    readFile,
    getOutputFormat,
    writeFile,
    revision,
    TextRenderer,
    version,
    logger
} from '../lib';

// ---------------------------------------------------------------------------
// SOG converter CLI
//
// A trimmed build of splat-transform that only converts the supported input
// formats (PLY, compressed PLY, SOG, SPLAT, SPZ) to SOG. By default it runs on
// the CPU (no GPU / `webgpu` dependency required); pass `-g <n|auto>` to use a
// GPU adapter for the SH k-means clustering pass.
//
//   splat-to-sog [options] <input> [output]
//
// If <output> is omitted, the result is written next to <input> with a `.sog`
// extension.
// ---------------------------------------------------------------------------

const usage = `
Convert Gaussian Splats to SOG
==============================

USAGE
  splat-to-sog [OPTIONS] <input> [output]

  • <input>  : .ply  .compressed.ply  .sog  meta.json  .splat  .spz
  • [output] : .sog (bundled) or meta.json (unbundled).
               Omit to write "<input-basename>.sog" next to the input.

OPTIONS
  -w, --overwrite              Overwrite the output if it already exists
  -i, --iterations <n>         SH compression iterations (more = better). Default: 10
  -g, --gpu <n|cpu|auto>       Device for SH clustering. Default: cpu
                                 cpu   - CPU k-means (no GPU needed)
                                 auto  - let WebGPU pick an adapter
                                 <n>   - GPU adapter index
  -q, --quiet                  Suppress non-error output
      --verbose                Show debug-level diagnostics
  -h, --help                   Show this help and exit
  -v, --version                Show version and exit

EXAMPLES
  splat-to-sog input.ply
  splat-to-sog input.spz scene.sog
  splat-to-sog -w -i 20 input.compressed.ply out/meta.json
`;

const fileExists = async (filename: string) => {
    try {
        await lstat(filename);
        return true;
    } catch (e: any) {
        if (e?.code === 'ENOENT') return false;
        throw e;
    }
};

const isGSDataTable = (dataTable: DataTable) => [
    'x', 'y', 'z',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
    'scale_0', 'scale_1', 'scale_2',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity'
].every(c => dataTable.hasColumn(c));

// Derive a sibling `.sog` path from an input path by stripping the recognized
// input extension. `.compressed.ply` is treated as a single extension.
const deriveOutput = (inputPath: string): string => {
    const lower = inputPath.toLowerCase();
    const strip = (suffix: string) => inputPath.slice(0, inputPath.length - suffix.length);
    if (lower.endsWith('.compressed.ply')) return `${strip('.compressed.ply')}.sog`;
    for (const ext of ['.ply', '.splat', '.spz', '.sog']) {
        if (lower.endsWith(ext)) return `${strip(ext)}.sog`;
    }
    if (lower.endsWith('meta.json')) return `${strip('meta.json').replace(/[._-]$/, '')}.sog`;
    return `${inputPath}.sog`;
};

const main = async () => {
    const startTime = performance.now();

    const peakMemoryBytes = (): number => {
        const raw = process.resourceUsage().maxRSS;
        return process.platform === 'win32' ? raw : raw * 1024;
    };
    const liveMemoryBytes = (): number => {
        const u = process.memoryUsage();
        return u.heapUsed + u.external;
    };

    const reportDone = (failed = false) => {
        const elapsedMs = performance.now() - startTime;
        const line = `${failed ? 'failed in' : 'done in'} ${fmtTime(elapsedMs)}  [peak ${fmtBytes(peakMemoryBytes())}]`;
        failed ? logger.error(line) : logger.info(line);
    };

    const failExit = (err: unknown): never => {
        logger.error(err);
        reportDone(true);
        exit(1);
    };

    // stderr renderer (line-buffered when stderr is not a TTY)
    const noTty = !process.stderr.isTTY;
    let lineBuf = '';
    const write = (chunk: string) => {
        if (noTty) {
            lineBuf += chunk;
            const lastNL = lineBuf.lastIndexOf('\n');
            if (lastNL !== -1) {
                process.stderr.write(lineBuf.slice(0, lastNL + 1));
                lineBuf = lineBuf.slice(lastNL + 1);
            }
        } else {
            process.stderr.write(chunk);
        }
    };
    const renderer = new TextRenderer({
        write,
        output: chunk => process.stdout.write(chunk),
        getPeakMemory: peakMemoryBytes,
        getLiveMemory: liveMemoryBytes
    });
    logger.setRenderer(renderer);

    process.on('uncaughtException', err => failExit(err));
    process.on('unhandledRejection', reason => failExit(reason));

    // parse args
    let values: any;
    let positionals: string[] = [];
    try {
        ({ values, positionals } = parseArgs({
            args: process.argv.slice(2),
            allowPositionals: true,
            options: {
                overwrite: { type: 'boolean', short: 'w', default: false },
                iterations: { type: 'string', short: 'i', default: '10' },
                gpu: { type: 'string', short: 'g', default: 'cpu' },
                quiet: { type: 'boolean', short: 'q', default: false },
                verbose: { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h', default: false },
                version: { type: 'boolean', short: 'v', default: false }
            }
        }));
    } catch (err) {
        failExit(err);
    }

    if (values.quiet) {
        logger.setVerbosity('quiet');
    } else if (values.verbose) {
        logger.setVerbosity('verbose');
    } else {
        logger.setVerbosity('normal');
    }

    logger.info(`splat-to-sog v${version} (${revision})`);

    if (values.version) {
        exit(0);
    }
    if (values.help || positionals.length < 1) {
        logger.output(usage.trim());
        exit(values.help ? 0 : 1);
    }

    const iterations = Number.parseInt(values.iterations, 10);
    if (!Number.isFinite(iterations) || iterations < 1) {
        failExit(`Invalid --iterations value: ${values.iterations}`);
    }

    const inputArg = positionals[0];
    const outputArg = positionals[1] ?? deriveOutput(inputArg);

    const inputFilename = resolve(inputArg);
    const outputFilename = resolve(outputArg);

    if (inputFilename === outputFilename) {
        failExit(`Output path equals input path: ${outputFilename}. Choose a different output.`);
    }

    let inputFormat: ReturnType<typeof getInputFormat>;
    let outputFormat: ReturnType<typeof getOutputFormat>;
    try {
        inputFormat = getInputFormat(inputFilename);
        outputFormat = getOutputFormat(outputFilename);
    } catch (err) {
        failExit(err);
    }

    if (values.overwrite) {
        await mkdir(dirname(outputFilename), { recursive: true });
    } else if (await fileExists(outputFilename)) {
        failExit(`File '${outputFilename}' already exists. Use -w to overwrite.`);
    }

    // device selection (default: CPU). Only import the GPU backend when asked.
    const gpu = String(values.gpu).toLowerCase();
    let deviceCreator: (() => Promise<GraphicsDevice>) | undefined;
    if (gpu !== 'cpu') {
        let cached: GraphicsDevice | undefined;
        deviceCreator = async () => {
            if (cached) return cached;
            const { createDevice, enumerateAdapters } = await import('./node-device');
            let adapterName: string | undefined;
            if (gpu !== 'auto') {
                const idx = Number.parseInt(gpu, 10);
                if (!Number.isInteger(idx) || idx < 0) {
                    throw new Error(`Invalid --gpu value: ${values.gpu}. Use cpu, auto, or a non-negative index.`);
                }
                const adapters = await enumerateAdapters();
                adapterName = adapters[idx]?.name;
                if (!adapterName) {
                    logger.warn(`GPU adapter index ${idx} not found, using default`);
                }
            }
            cached = await createDevice(adapterName);
            return cached;
        };
    }

    try {
        // read
        const readGroup = logger.group(`Input ${inputArg}`);
        const reading = logger.group('Reading');
        const dataTable = await readFile({
            filename: inputFilename,
            inputFormat,
            fileSystem: new NodeReadFileSystem()
        });
        reading.end();

        if (dataTable.numRows === 0 || !isGSDataTable(dataTable)) {
            throw new Error(`Unsupported / empty Gaussian splat data in '${inputArg}'`);
        }
        logger.info(`${fmtCount(dataTable.numRows)} gaussians · ${getSHBands(dataTable)} SH bands · ${fmtBytes(dataTable.byteLength)}`);
        readGroup.end();

        // write
        const writeGroup = logger.group(`Output ${outputArg}`);
        await writeFile({
            filename: outputFilename,
            outputFormat,
            dataTable,
            options: { iterations },
            createDevice: deviceCreator
        }, new NodeFileSystem());
        writeGroup.end();
    } catch (err) {
        failExit(err);
    }

    reportDone();

    // webgpu can keep the event loop alive; force exit
    exit(0);
};

export { main };
