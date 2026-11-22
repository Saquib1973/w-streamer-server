/** Minimal typings for the subset of WebTorrent v3 we use. */
declare module "webtorrent" {
  import { EventEmitter } from "node:events";
  import type { Readable } from "node:stream";

  export interface TorrentFile {
    name: string;
    path: string;
    length: number;
    downloaded: number;
    progress: number;
    select(priority?: number): void;
    deselect(): void;
    createReadStream(opts?: { start?: number; end?: number }): Readable;
  }

  export interface Torrent extends EventEmitter {
    infoHash: string;
    magnetURI: string;
    name: string;
    length: number;
    files: TorrentFile[];
    ready: boolean;
    done: boolean;
    paused: boolean;
    destroyed: boolean;
    numPeers: number;
    downloadSpeed: number;
    uploadSpeed: number;
    downloaded: number;
    progress: number;
    pieceLength: number;
    select(start: number, end: number, priority?: number, notify?: () => void): void;
    deselect(start: number, end: number, priority?: number): void;
    critical(start: number, end: number): void;
    destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
  }

  export interface AddOptions {
    path?: string;
    announce?: string[];
    deselect?: boolean;
    strategy?: "sequential" | "rarest";
    destroyStoreOnDestroy?: boolean;
  }

  export interface Options {
    maxConns?: number;
    dht?: boolean;
    lsd?: boolean;
    utp?: boolean;
    webSeeds?: boolean;
    tracker?: boolean | object;
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: Options);
    torrents: Torrent[];
    add(id: string | Buffer, opts?: AddOptions, onTorrent?: (t: Torrent) => void): Torrent;
    get(id: string): Promise<Torrent | null>;
    remove(id: string | Torrent, opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): Promise<void> | void;
    destroy(cb?: (err?: Error) => void): void;
  }
}
