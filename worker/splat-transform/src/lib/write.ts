import { DataTable } from './data-table';
import { type FileSystem } from './io/write';
import { type DeviceCreator, type Options } from './types';
import { writeSog } from './writers';

/**
 * Supported output file formats (trimmed SOG-converter build).
 *
 * - `sog` - PlayCanvas SOG format (unbundled: meta.json + .webp textures)
 * - `sog-bundle` - PlayCanvas SOG format (bundled into a single .sog file)
 */
type OutputFormat = 'sog' | 'sog-bundle';

/**
 * Options for writing a Gaussian splat file.
 */
type WriteOptions = {
    /** Path to the output file. */
    filename: string;
    /** The format to write. */
    outputFormat: OutputFormat;
    /** The splat data to write. */
    dataTable: DataTable;
    /** Processing options. */
    options: Options;
    /** Optional function to create a GPU device for compression. */
    createDevice?: DeviceCreator;
};

/**
 * Determines the output format based on file extension.
 *
 * @param filename - The filename to analyze.
 * @returns The detected output format.
 * @throws Error if the file extension is not recognized.
 */
const getOutputFormat = (filename: string): OutputFormat => {
    const lowerFilename = filename.toLowerCase();

    if (lowerFilename.endsWith('.sog')) {
        return 'sog-bundle';
    } else if (lowerFilename.endsWith('meta.json')) {
        return 'sog';
    }

    throw new Error(`Unsupported output file type: ${filename} (only .sog / meta.json are supported)`);
};

/**
 * Writes Gaussian splat data to a SOG file.
 *
 * @param writeOptions - Options specifying the data and format to write.
 * @param fs - File system abstraction for writing files.
 */
const writeFile = async (writeOptions: WriteOptions, fs: FileSystem) => {
    const { filename, outputFormat, dataTable, options, createDevice } = writeOptions;

    await writeSog({
        filename,
        dataTable,
        bundle: outputFormat === 'sog-bundle',
        iterations: options.iterations,
        createDevice
    }, fs);
};

export { getOutputFormat, writeFile, type OutputFormat, type WriteOptions };
