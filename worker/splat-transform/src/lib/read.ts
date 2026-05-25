import { DataTable } from './data-table';
import { ReadFileSystem, ZipReadFileSystem } from './io/read';
import { readPly, readSog, readSplat, readSpz } from './readers';

/**
 * Supported input file formats for Gaussian splat data (trimmed SOG-converter build).
 *
 * - `ply` - PLY format (standard 3DGS training output); compressed PLY is
 *   auto-detected and decompressed by the PLY reader.
 * - `splat` - Antimatter15 splat format
 * - `spz` - Niantic Labs compressed format
 * - `sog` - PlayCanvas SOG format (WebP-compressed; bundled `.sog` or unbundled `meta.json`)
 */
type InputFormat = 'splat' | 'sog' | 'ply' | 'spz';

/**
 * Determines the input format based on file extension.
 *
 * @param filename - The filename to analyze.
 * @returns The detected input format.
 * @throws Error if the file extension is not recognized.
 */
// Strip a trailing `?...` querystring and/or `#...` fragment from the basename
// so extension sniffing works for URL-shaped inputs. Only the basename (text
// after the last `/` or `\`) is considered.
const stripQueryAndHash = (filename: string): string => {
    const lastSep = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
    const basenameStart = lastSep + 1;
    const q = filename.slice(basenameStart).search(/[?#]/);
    return q < 0 ? filename : filename.slice(0, basenameStart + q);
};

const getInputFormat = (filename: string): InputFormat => {
    const lowerFilename = stripQueryAndHash(filename).toLowerCase();

    if (lowerFilename.endsWith('.splat')) {
        return 'splat';
    } else if (lowerFilename.endsWith('.sog') || lowerFilename.endsWith('meta.json')) {
        return 'sog';
    } else if (lowerFilename.endsWith('.ply')) {
        // covers both `.ply` and `.compressed.ply` (auto-detected on read)
        return 'ply';
    } else if (lowerFilename.endsWith('.spz')) {
        return 'spz';
    }

    throw new Error(`Unsupported input file type: ${filename}`);
};

/**
 * Options for reading a Gaussian splat file.
 */
type ReadFileOptions = {
    /** Path to the input file. */
    filename: string;
    /** The format of the input file. */
    inputFormat: InputFormat;
    /** File system abstraction for reading files. */
    fileSystem: ReadFileSystem;
};

/**
 * Reads a Gaussian splat file and returns its data as a DataTable.
 *
 * Supports PLY (+ compressed PLY), SPLAT, SPZ, and SOG inputs.
 *
 * @param readFileOptions - Options specifying the file to read and how to read it.
 * @returns Promise resolving to the DataTable containing the splat data.
 */
const readFile = async (readFileOptions: ReadFileOptions): Promise<DataTable> => {
    const { filename, inputFormat, fileSystem } = readFileOptions;

    if (inputFormat === 'sog') {
        const lowerFilename = stripQueryAndHash(filename).toLowerCase();
        if (lowerFilename.endsWith('.sog')) {
            // Outer .sog is a ZIP container - mount it and let the inner SOG
            // reader drive its own decode bar against the zipped payloads.
            const source = await fileSystem.createSource(filename);
            const zipFs = new ZipReadFileSystem(source);
            try {
                return await readSog(zipFs, 'meta.json');
            } finally {
                zipFs.close();
            }
        }
        return await readSog(fileSystem, filename);
    }

    const source = await fileSystem.createSource(filename);
    try {
        if (inputFormat === 'ply') {
            return await readPly(source);
        } else if (inputFormat === 'splat') {
            return await readSplat(source);
        }
        // spz
        return await readSpz(source);
    } finally {
        source.close();
    }
};

export { readFile, getInputFormat, type InputFormat, type ReadFileOptions };
