// ============================================================
// GENESIS — types/node.d.ts
// Minimal Node.js type declarations for TypeScript checking.
// Covers built-in modules used across Genesis source files.
// Added v5.6.0 to enable @ts-nocheck removal.
// ============================================================

// ── Globals ──────────────────────────────────────────────────

declare var process: {
  env: Record<string, string | undefined>;
  cwd(): string;
  exit(code?: number): never;
  exitCode: number | undefined;
  pid: number;
  platform: string;
  arch: string;
  argv: string[];
  versions: Record<string, string>;
  version: string;
  send?(message: any, sendHandle?: any, options?: any, callback?: Function): boolean;
  hrtime: {
    bigint(): bigint;
    (time?: [number, number]): [number, number];
  };
  memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
  nextTick(callback: (...args: any[]) => void, ...args: any[]): void;
  on(event: string, listener: (...args: any[]) => void): any;
  removeListener(event: string, listener: (...args: any[]) => void): any;
  uptime(): number;
  kill(pid: number, signal?: string | number): boolean;
  stdout: { write(data: string): boolean };
  stderr: { write(data: string): boolean };
};

declare var __dirname: string;
declare var __filename: string;
declare var global: typeof globalThis;

declare class Buffer extends Uint8Array {
  static from(data: string | ArrayBuffer | SharedArrayBuffer | readonly number[] | Buffer, encoding?: string): Buffer;
  static alloc(size: number, fill?: string | number, encoding?: string): Buffer;
  static isBuffer(obj: any): obj is Buffer;
  static concat(list: Buffer[], totalLength?: number): Buffer;
  static byteLength(string: string, encoding?: string): number;
  toString(encoding?: string, start?: number, end?: number): string;
  toJSON(): { type: 'Buffer'; data: number[] };
  length: number;
}

declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): ReturnType<typeof globalThis.setTimeout>;
declare function clearTimeout(id: ReturnType<typeof setTimeout>): void;
declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): ReturnType<typeof globalThis.setInterval>;
declare function clearInterval(id: ReturnType<typeof setInterval>): void;
declare function setImmediate(callback: (...args: any[]) => void, ...args: any[]): any;
declare function clearImmediate(id: any): void;

interface NodeRequire {
  (id: string): any;
  resolve(id: string): string;
  cache: Record<string, any>;
}
declare var require: NodeRequire;

// ── V8 Error extensions ─────────────────────────────────────

interface ErrorConstructor {
  captureStackTrace(target: object, constructorOpt?: Function): void;
  stackTraceLimit: number;
}

interface Error {
  code?: string;
}

declare namespace NodeJS {
  interface Timeout {
    ref(): this;
    unref(): this;
    hasRef(): boolean;
    refresh(): this;
    [Symbol.toPrimitive](): number;
  }
  interface Timer extends Timeout {}
}

// ── fs ───────────────────────────────────────────────────────

declare module 'fs' {
  export function readFileSync(path: string, options: { encoding: string; flag?: string } | string): string;
  export function readFileSync(path: string, options?: { encoding?: undefined; flag?: string }): Buffer;
  export function writeFileSync(path: string | number, data: string | Buffer, options?: { encoding?: string; mode?: number; flag?: string } | string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined;
  export function readdirSync(path: string, options?: { withFileTypes?: boolean; encoding?: string } | string): any[];
  export function statSync(path: string, options?: { throwIfNoEntry?: boolean }): { isFile(): boolean; isDirectory(): boolean; size: number; mtime: Date; mtimeMs: number; birthtime: Date };
  export function unlinkSync(path: string): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function copyFileSync(src: string, dest: string, mode?: number): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function accessSync(path: string, mode?: number): void;
  export function chmodSync(path: string, mode: string | number): void;
  export function lstatSync(path: string): { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number };
  export function symlinkSync(target: string, path: string, type?: string): void;
  export function readlinkSync(path: string): string;
  export function createReadStream(path: string, options?: any): any;
  export function createWriteStream(path: string, options?: any): any;
  export function watch(path: string, options?: any, listener?: any): any;
  export function watchFile(path: string, options?: any, listener?: any): any;
  export function unwatchFile(path: string, listener?: any): void;
  export const constants: { F_OK: number; R_OK: number; W_OK: number; X_OK: number };
  export function openSync(path: string, flags: string | number, mode?: number): number;
  export function closeSync(fd: number): void;
  export function fdatasyncSync(fd: number): void;
  export function writeSync(fd: number, data: string | Buffer, offset?: number, length?: number, position?: number): number;
  export function readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  export function fstatSync(fd: number): { isFile(): boolean; isDirectory(): boolean; size: number; mtime: Date };
  export function ftruncateSync(fd: number, len?: number): void;
  export function fsyncSync(fd: number): void;
  export function appendFileSync(path: string, data: string | Buffer, options?: any): void;
  export const promises: typeof import('fs/promises');
}

declare module 'fs/promises' {
  export function readFile(path: string, options: { encoding: string; flag?: string } | string): Promise<string>;
  export function readFile(path: string, options?: { encoding?: undefined; flag?: string }): Promise<Buffer>;
  export function writeFile(path: string, data: string | Buffer, options?: { encoding?: string; mode?: number; flag?: string } | string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
  export function readdir(path: string, options?: { withFileTypes?: boolean } | string): Promise<any[]>;
  export function stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number; mtime: Date; mtimeMs: number }>;
  export function unlink(path: string): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function access(path: string, mode?: number): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function copyFile(src: string, dest: string): Promise<void>;
  export function open(path: string, flags?: string | number, mode?: number): Promise<{
    fd: number;
    read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number; buffer: Buffer }>;
    write(data: string | Buffer, position?: number, encoding?: string): Promise<{ bytesWritten: number; buffer: Buffer }>;
    writeFile(data: string | Buffer, options?: { encoding?: string } | string): Promise<void>;
    close(): Promise<void>;
    datasync(): Promise<void>;
    sync(): Promise<void>;
    truncate(len?: number): Promise<void>;
    stat(): Promise<any>;
  }>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function appendFile(path: string, data: string | Buffer, options?: any): Promise<void>;
}

// ── path ─────────────────────────────────────────────────────

declare module 'path' {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
  export function normalize(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function parse(path: string): { root: string; dir: string; base: string; ext: string; name: string };
  export function format(pathObject: { root?: string; dir?: string; base?: string; ext?: string; name?: string }): string;
  export const sep: string;
  export const delimiter: string;
  export const posix: any;
  export const win32: any;
}

// ── crypto ───────────────────────────────────────────────────

declare module 'crypto' {
  export function createHash(algorithm: string): {
    update(data: string | Buffer, encoding?: string): any;
    digest(encoding: string): string;
    digest(): Buffer;
  };
  export function randomUUID(): string;
  export function randomBytes(size: number): Buffer;
  export function createHmac(algorithm: string, key: string | Buffer): {
    update(data: string | Buffer): any;
    digest(encoding: string): string;
    digest(): Buffer;
  };
  export function pbkdf2Sync(password: string | Buffer, salt: string | Buffer, iterations: number, keylen: number, digest: string): Buffer;
  export function createCipheriv(algorithm: string, key: Buffer | Uint8Array, iv: Buffer | Uint8Array | null): {
    update(data: string, inputEncoding?: string, outputEncoding?: string): string;
    final(outputEncoding?: string): string;
    setAuthTag?(tag: Buffer | Uint8Array): any;
    getAuthTag?(): Buffer;
  };
  export function createDecipheriv(algorithm: string, key: Buffer | Uint8Array, iv: Buffer | Uint8Array | null): {
    update(data: string | Buffer | Uint8Array, inputEncoding?: string | null, outputEncoding?: string): string;
    final(outputEncoding?: string): string;
    setAuthTag?(tag: Buffer | Uint8Array): any;
  };
  export function timingSafeEqual(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean;
}

// ── os ───────────────────────────────────────────────────────

declare module 'os' {
  export function homedir(): string;
  export function tmpdir(): string;
  export function platform(): string;
  export function hostname(): string;
  export function cpus(): Array<{ model: string; speed: number; times: { user: number; nice: number; sys: number; idle: number; irq: number } }>;
  export function totalmem(): number;
  export function freemem(): number;
  export function type(): string;
  export function arch(): string;
  export function release(): string;
  export function uptime(): number;
  export function userInfo(options?: { encoding?: string }): { username: string; uid: number; gid: number; shell: string; homedir: string };
  export const EOL: string;
}

// ── child_process ────────────────────────────────────────────

declare module 'child_process' {
  export function spawn(command: string, args?: string[], options?: {
    cwd?: string; env?: Record<string, string>; stdio?: any; shell?: boolean | string;
    timeout?: number; maxBuffer?: number; windowsHide?: boolean; signal?: AbortSignal;
  }): {
    pid: number | undefined;
    stdin: any; stdout: any; stderr: any;
    on(event: string, listener: (...args: any[]) => void): any;
    kill(signal?: string | number): boolean;
    kill(pid: number, signal?: string | number): boolean;
  };

  export function execSync(command: string, options?: {
    cwd?: string; encoding?: string; timeout?: number; maxBuffer?: number; shell?: string;
    env?: Record<string, string>; stdio?: any; windowsHide?: boolean;
  }): string | Buffer;

  export function exec(command: string, options?: any, callback?: (error: Error | null, stdout: string, stderr: string) => void): any;

  export function execFile(file: string, args?: string[], options?: any, callback?: (error: Error | null, stdout: string, stderr: string) => void): any;

  export function execFileSync(file: string, args?: string[], options?: {
    cwd?: string; encoding?: string; timeout?: number; maxBuffer?: number;
    env?: Record<string, string>; stdio?: any; shell?: boolean; windowsHide?: boolean;
  }): string | Buffer;

  export function fork(modulePath: string, args?: string[], options?: {
    cwd?: string; env?: Record<string, string>; execPath?: string; execArgv?: string[];
    silent?: boolean; stdio?: any; serialization?: string; signal?: AbortSignal;
  }): any;
}

// ── http ─────────────────────────────────────────────────────

declare module 'http' {
  export class IncomingMessage {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    statusCode?: number;
    statusMessage?: string;
    socket: any;
    on(event: string, listener: (...args: any[]) => void): this;
    pipe(destination: any, options?: any): any;
    destroy(error?: Error): this;
  }
  export class ServerResponse {
    statusCode: number;
    statusMessage: string;
    headersSent: boolean;
    setHeader(name: string, value: string | number | readonly string[]): this;
    getHeader(name: string): string | number | string[] | undefined;
    removeHeader(name: string): void;
    writeHead(statusCode: number, headers?: Record<string, string | number | readonly string[]>): this;
    write(chunk: string | Buffer, encoding?: string, callback?: () => void): boolean;
    end(chunk?: string | Buffer, encoding?: string, callback?: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  export function createServer(requestListener?: (req: IncomingMessage, res: ServerResponse) => void): {
    listen(port?: number, hostname?: string, callback?: () => void): any;
    close(callback?: (err?: Error) => void): any;
    address(): { port: number; family: string; address: string } | string | null;
    on(event: string, listener: (...args: any[]) => void): any;
  };
  export function request(options: any, callback?: (res: any) => void): any;
  export function request(url: string, options: any, callback?: (res: any) => void): any;
  export function get(options: any, callback?: (res: any) => void): any;
  export function get(url: string, options: any, callback?: (res: any) => void): any;
}

// ── async_hooks ──────────────────────────────────────────────

declare module 'async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R;
    enterWith(store: T): void;
    disable(): void;
  }
  export function createHook(hooks: {
    init?: (asyncId: number, type: string, triggerAsyncId: number, resource: any) => void;
    before?: (asyncId: number) => void;
    after?: (asyncId: number) => void;
    destroy?: (asyncId: number) => void;
    promiseResolve?: (asyncId: number) => void;
  }): { enable(): any; disable(): any };
  export function executionAsyncId(): number;
  export function triggerAsyncId(): number;
}

// ── worker_threads ───────────────────────────────────────────

declare module 'worker_threads' {
  export class Worker {
    constructor(filename: string | URL, options?: {
      workerData?: any; resourceLimits?: { maxOldGenerationSizeMb?: number; maxYoungGenerationSizeMb?: number; codeRangeSizeMb?: number; stackSizeMb?: number };
      execArgv?: string[]; env?: Record<string, string>; transferList?: any[];
    });
    postMessage(value: any, transferList?: any[]): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    terminate(): Promise<number>;
    ref(): void;
    unref(): void;
    threadId: number;
  }
  export const isMainThread: boolean;
  export const parentPort: {
    postMessage(value: any): void;
    on(event: string, listener: (...args: any[]) => void): any;
    once(event: string, listener: (...args: any[]) => void): any;
  } | null;
  export const workerData: any;
  export const threadId: number;
}

// ── chokidar (vendor) ────────────────────────────────────────

declare module 'chokidar' {
  export function watch(paths: string | string[], options?: {
    persistent?: boolean; ignoreInitial?: boolean; depth?: number;
    ignored?: any; cwd?: string; usePolling?: boolean; interval?: number;
  }): {
    on(event: string, listener: (...args: any[]) => void): any;
    close(): Promise<void>;
    add(paths: string | string[]): any;
    unwatch(paths: string | string[]): any;
  };
}

// ── vm ───────────────────────────────────────────────────────

declare module 'vm' {
  export function createContext(sandbox?: object): object;
  export function runInContext(code: string, context: object, options?: { timeout?: number; filename?: string }): any;
  export function runInNewContext(code: string, sandbox?: object, options?: { timeout?: number; filename?: string }): any;
  export class Script {
    constructor(code: string, options?: { filename?: string; lineOffset?: number; columnOffset?: number; timeout?: number });
    runInContext(context: object, options?: { timeout?: number }): any;
    runInNewContext(sandbox?: object, options?: { timeout?: number }): any;
  }
}

// ── acorn (vendor) ───────────────────────────────────────────

declare module 'acorn' {
  export function parse(input: string, options?: {
    ecmaVersion?: number | 'latest';
    sourceType?: 'script' | 'module';
    locations?: boolean;
    ranges?: boolean;
    allowReturnOutsideFunction?: boolean;
    [key: string]: any;
  }): any;
}

// ── util ─────────────────────────────────────────────────────

declare module 'util' {
  export function inspect(object: any, options?: { depth?: number | null; colors?: boolean; showHidden?: boolean; maxArrayLength?: number; maxStringLength?: number; breakLength?: number; compact?: boolean | number; sorted?: boolean | ((a: string, b: string) => number); getters?: boolean | 'get' | 'set'; numericSeparator?: boolean }): string;
  export function format(format?: any, ...param: any[]): string;
  export function promisify<T extends (...args: any[]) => any>(fn: T): (...args: any[]) => Promise<any>;
  export function deprecate<T extends Function>(fn: T, msg: string, code?: string): T;
  export function isDeepStrictEqual(val1: any, val2: any): boolean;
  export const types: {
    isDate(value: any): value is Date;
    isRegExp(value: any): value is RegExp;
    isPromise(value: any): value is Promise<any>;
    isArrayBuffer(value: any): value is ArrayBuffer;
  };
  export class TextDecoder {
    constructor(encoding?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
    decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
  }
  export class TextEncoder {
    encode(input?: string): Uint8Array;
  }
}

// ── https ───────────────────────────────────────────────────

declare module 'https' {
  export function get(url: string | URL, options: any, callback?: (res: any) => void): any;
  export function get(url: string | URL, callback?: (res: any) => void): any;
  export function request(url: string | URL, options?: any, callback?: (res: any) => void): any;
  export function request(options: object, callback?: (res: any) => void): any;
}

// ── dns ─────────────────────────────────────────────────────

declare module 'dns' {
  export function resolve(hostname: string, callback: (err: Error | null, addresses: string[]) => void): void;
  export function resolve(hostname: string, rrtype: string, callback: (err: Error | null, addresses: any) => void): void;
  export function lookup(hostname: string, callback: (err: Error | null, address: string, family: number) => void): void;
  export function lookup(hostname: string, options: any, callback: (err: Error | null, address: string, family: number) => void): void;
  export const promises: {
    resolve(hostname: string, rrtype?: string): Promise<any>;
    lookup(hostname: string, options?: any): Promise<{ address: string; family: number }>;
  };
}

declare module 'tree-kill' {
  function treeKill(pid: number, signal?: string, callback?: (err?: Error) => void): void;
  export = treeKill;
}

declare module 'url' {
  export class URL {
    constructor(input: string, base?: string | URL);
    hash: string; host: string; hostname: string; href: string;
    origin: string; password: string; pathname: string; port: string;
    protocol: string; search: string; searchParams: any; username: string;
    toString(): string; toJSON(): string;
  }
  export function parse(urlString: string, parseQueryString?: boolean): any;
  export function format(urlObject: any): string;
}

// ── events ───────────────────────────────────────────────────
// v5.9.8: ConsciousnessExtension extends EventEmitter

declare module 'events' {
  class EventEmitter {
    constructor(options?: { captureRejections?: boolean });
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this;
    off(event: string | symbol, listener: (...args: any[]) => void): this;
    emit(event: string | symbol, ...args: any[]): boolean;
    addListener(event: string | symbol, listener: (...args: any[]) => void): this;
    removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
    removeAllListeners(event?: string | symbol): this;
    listeners(event: string | symbol): Function[];
    listenerCount(event: string | symbol): number;
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
    prependListener(event: string | symbol, listener: (...args: any[]) => void): this;
    eventNames(): (string | symbol)[];
  }
  export = EventEmitter;
}

// ── electron (optional runtime dep) ─────────────────────────
// v5.9.8: EffectorRegistry conditional require

declare module 'electron' {
  export const app: any;
  export const BrowserWindow: any;
  export const ipcMain: any;
  export const ipcRenderer: any;
  export const dialog: any;
  export const shell: any;
  export const clipboard: any;
  export const nativeTheme: any;
  export const screen: any;
  export const globalShortcut: any;
  export class Notification {
    constructor(options?: any);
    static isSupported(): boolean;
    show(): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
}

// ── cheerio / puppeteer (optional deps) ─────────────────────
// v5.9.8: WebPerception conditional require

declare module 'cheerio' {
  export function load(html: string, options?: any): any;
}

declare module 'puppeteer' {
  export function launch(options?: any): Promise<any>;
}
