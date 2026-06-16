import process from 'node:process';

import { GraphicsDevice, WebgpuGraphicsDevice } from 'playcanvas';
import { create, globals } from 'webgpu';

import { logger } from '../lib';

type AdapterInfo = {
    index: number;
    backend: string;
    name: string;
    isNvidia: boolean;
    isSoftware: boolean;
};

const initializeGlobals = () => {
    Object.assign(globalThis, globals);

    // window stub
    (globalThis as any).window = {
        navigator: { userAgent: 'node.js' }
    };

    // document stub
    (globalThis as any).document = {
        createElement: (type: string) => {
            if (type === 'canvas') {
                return {
                    getContext: (): null => {
                        return null;
                    },
                    getBoundingClientRect: () => {
                        return {
                            left: 0,
                            top: 0,
                            width: 300,
                            height: 150,
                            right: 300,
                            bottom: 150
                        };
                    },
                    width: 300,
                    height: 150
                };
            }
        }
    };
};

initializeGlobals();

const preferredBackend = (): string | undefined => {
    const configured = process.env.SOG_DAWN_BACKEND;
    if (configured !== undefined) {
        const value = configured.trim().toLowerCase();
        return value && value !== 'auto' ? value : undefined;
    }

    return process.platform === 'linux' ? 'vulkan' : undefined;
};

const dawnOptionsFor = (backend?: string, adapterName?: string): string[] => {
    const options: string[] = [];
    if (backend) {
        options.push(`backend=${backend}`);
    }
    if (adapterName) {
        options.push(`adapter=${adapterName}`);
    }
    return options;
};

const isSoftwareAdapter = (name: string): boolean => (
    /swiftshader|llvmpipe|lavapipe|software|basic render|mesa offscreen/i.test(name)
);

const isNvidiaAdapter = (name: string): boolean => (
    /nvidia|geforce|quadro|rtx|tesla|\bl4\b|l40s?|\ba10\b|\ba16\b|\ba40\b|\ba100\b|\bh100\b|\bh200\b|gb10|blackwell/i.test(name)
);

// Get Dawn's actual adapter list by triggering its error message.
// This is the official documented method for enumerating adapters:
// https://github.com/dawn-gpu/node-webgpu?tab=readme-ov-file#usage
const getDawnAdapters = async (backend?: string): Promise<Array<Omit<AdapterInfo, 'index'>>> => {
    try {
        const gpu = create(dawnOptionsFor(backend, '__list_adapters__'));
        await gpu.requestAdapter();
    } catch (e) {
        // Parse Dawn's error message to extract adapter backends and names.
        const message = e instanceof Error ? e.message : String(e);
        const lines = message.split('\n');
        const adapters: Array<Omit<AdapterInfo, 'index'>> = [];

        for (const line of lines) {
            // Lines look like: " * backend: 'vulkan', name: 'NVIDIA GeForce RTX 4090'"
            const match = line.match(/backend:\s*'([^']+)'.*name:\s*'([^']+)'/);
            if (match) {
                const name = match[2];
                adapters.push({
                    backend: match[1],
                    name,
                    isNvidia: isNvidiaAdapter(name),
                    isSoftware: isSoftwareAdapter(name)
                });
            }
        }

        return adapters;
    }

    // Unexpected: requestAdapter should have thrown with invalid adapter name
    logger.warn('Expected adapter enumeration to throw an error, but it did not.');
    return [];
};

// Cache enumerated adapters so we don't query Dawn multiple times
const cachedAdapters = new Map<string, AdapterInfo[]>();

const enumerateAdapters = async () => {
    const backend = preferredBackend();
    const cacheKey = backend ?? 'default';
    const cached = cachedAdapters.get(cacheKey);
    if (cached) {
        return cached;
    }

    try {
        logger.info(`Detecting GPU adapters${backend ? ` (backend=${backend})` : ''}...`);

        let dawnAdapters = await getDawnAdapters(backend);
        if (backend && dawnAdapters.length === 0) {
            logger.warn(`No GPU adapters found for backend=${backend}; retrying with Dawn default backend selection.`);
            dawnAdapters = await getDawnAdapters();
        }

        const adapters = dawnAdapters.map((adapter, index) => ({
            index,
            ...adapter
        }));

        if (adapters.length > 0) {
            for (const adapter of adapters) {
                logger.info(`GPU adapter ${adapter.index}: backend=${adapter.backend}, name=${adapter.name}`);
            }
        }

        cachedAdapters.set(cacheKey, adapters);
        return adapters;
    } catch (e) {
        logger.error('Failed to enumerate adapters. Error:', e);
        logger.error('\nThis usually means WebGPU is not available. Please ensure:');
        logger.error('  - Your GPU drivers are up to date');
        logger.error('  - Your GPU supports Vulkan, D3D12, or Metal');
        return [];
    }
};

const scoreAdapter = (adapter: AdapterInfo): number => {
    let score = 0;
    if (adapter.backend === 'vulkan') score += 400;
    if (adapter.backend === 'd3d12') score += 300;
    if (adapter.backend === 'metal') score += 200;
    if (adapter.isNvidia) score += 1000;
    if (/rtx|ada|blackwell|gb10|geforce/i.test(adapter.name)) score += 100;
    if (adapter.isSoftware) score -= 2000;
    return score;
};

const selectAutoAdapter = async (): Promise<AdapterInfo | undefined> => {
    const adapters = await enumerateAdapters();
    if (adapters.length === 0) {
        return undefined;
    }

    const preferNvidia = process.env.SOG_PREFER_NVIDIA !== '0';
    const hardwareAdapters = adapters.filter(adapter => !adapter.isSoftware);
    const preferredAdapters = preferNvidia ? hardwareAdapters.filter(adapter => adapter.isNvidia) : hardwareAdapters;
    const pool = preferredAdapters.length > 0 ? preferredAdapters : hardwareAdapters;
    if (pool.length === 0) {
        throw new Error('No hardware WebGPU adapter found. Only software Vulkan adapters are available; use CPU fallback.');
    }

    const selected = [...pool].sort((a, b) => scoreAdapter(b) - scoreAdapter(a))[0];
    logger.info(`Selected GPU adapter ${selected.index}: backend=${selected.backend}, name=${selected.name}`);
    return selected;
};

const createDevice = async (adapter?: AdapterInfo): Promise<GraphicsDevice> => {
    // Use Dawn's backend/adapter selection when a specific adapter is provided.
    const dawnOptions = dawnOptionsFor(adapter?.backend ?? preferredBackend(), adapter?.name);

    // @ts-ignore
    window.navigator.gpu = create(dawnOptions);

    const canvas = document.createElement('canvas');

    canvas.width = 1024;
    canvas.height = 512;

    const graphicsDevice = new WebgpuGraphicsDevice(canvas, {
        antialias: false,
        depth: false,
        stencil: false
    });

    await graphicsDevice.createDevice();

    // Surface Dawn's device-lost reason directly. PlayCanvas logs this only via
    // Debug.warn (debug builds) and then attempts to recreate the device, which
    // can fail noisily (e.g. DXGI_ERROR_DEVICE_REMOVED on D3D12 TDR) and bury
    // the original cause. Skip the `destroyed` reason - that fires on intentional
    // device.destroy() during normal shutdown.
    // @ts-ignore - wgpu is private on WebgpuGraphicsDevice but exposed in practice
    (graphicsDevice.wgpu as any)?.lost?.then((info: any) => {
        if (info?.reason === 'destroyed') return;
        logger.error(`WebGPU device was lost: reason=${info.reason || 'unknown'}, message=${info.message || '(none)'}`);
    });

    return graphicsDevice;
};

export { createDevice, enumerateAdapters, selectAutoAdapter, type AdapterInfo };
