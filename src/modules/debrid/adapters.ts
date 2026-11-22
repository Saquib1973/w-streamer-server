import type { DebridProvider } from "../../contracts/api.js";
import { AppError } from "../../lib/errors.js";
import { fetchJson } from "../../lib/http-client.js";
import { pickFile, sleep, type DebridAdapter, type DebridTarget } from "./types.js";

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const notCached = (p: string) => new AppError("DEBRID_ERROR", `${p}: not cached`, { notCached: true });

/* ═══════════════ Real-Debrid ═══════════════
 * instantAvailability was disabled by RD (Nov 2024), so cache is discovered by
 * adding the magnet and checking whether it's immediately "downloaded".
 */
const RD = "https://api.real-debrid.com/rest/1.0";

interface RdInfo {
  id: string;
  status: string;
  filename: string;
  files: { id: number; path: string; bytes: number; selected: number }[];
  links: string[];
}

export const realDebrid: DebridAdapter = {
  provider: "REAL_DEBRID",
  async checkCached() {
    return new Map();
  },
  async resolve(token, t) {
    const o = { headers: auth(token), errorCode: "DEBRID_ERROR" as const, label: "Real-Debrid", timeoutMs: 10_000 };
    const added = await fetchJson<{ id: string }>(`${RD}/torrents/addMagnet`, { ...o, method: "POST", form: { magnet: t.magnet } });
    const cleanup = () => fetchJson(`${RD}/torrents/delete/${added.id}`, { ...o, method: "DELETE" }).catch(() => undefined);
    try {
      let info = await fetchJson<RdInfo>(`${RD}/torrents/info/${added.id}`, o);
      for (let i = 0; i < 10 && info.status === "magnet_conversion"; i++) {
        await sleep(500);
        info = await fetchJson<RdInfo>(`${RD}/torrents/info/${added.id}`, o);
      }
      const files = info.files.map((f) => ({ ref: f.id, path: f.path, size: f.bytes }));
      const file = pickFile(files, t, files);
      if (!file) throw new AppError("DEBRID_ERROR", "Real-Debrid: no playable file");
      await fetchJson(`${RD}/torrents/selectFiles/${added.id}`, { ...o, method: "POST", form: { files: String(file.ref) } });

      for (let i = 0; i < 6; i++) {
        info = await fetchJson<RdInfo>(`${RD}/torrents/info/${added.id}`, o);
        if (info.status === "downloaded") break;
        if (["error", "virus", "dead", "magnet_error"].includes(info.status)) throw new AppError("DEBRID_ERROR", `Real-Debrid: ${info.status}`);
        await sleep(700);
      }
      if (info.status !== "downloaded" || !info.links[0]) {
        await cleanup();
        throw notCached("Real-Debrid");
      }
      const u = await fetchJson<{ download: string; filename: string; filesize: number }>(`${RD}/unrestrict/link`, {
        ...o,
        method: "POST",
        form: { link: info.links[0] },
      });
      return { url: u.download, filename: u.filename, sizeBytes: u.filesize };
    } catch (e) {
      if (!(e instanceof AppError && (e.details as { notCached?: boolean })?.notCached)) await cleanup();
      throw e;
    }
  },
};

/* ═══════════════ TorBox ═══════════════ */
const TB = "https://api.torbox.app/v1/api";

interface TbEnvelope<T> {
  success: boolean;
  detail?: string;
  data: T;
}

export const torBox: DebridAdapter = {
  provider: "TORBOX",
  async checkCached(token, hashes) {
    const out = new Map<string, boolean>();
    for (let i = 0; i < hashes.length; i += 100) {
      const chunk = hashes.slice(i, i + 100);
      const r = await fetchJson<TbEnvelope<{ hash: string }[] | Record<string, unknown> | null>>(
        `${TB}/torrents/checkcached?hash=${chunk.join(",")}&format=list&list_files=false`,
        { headers: auth(token), errorCode: "DEBRID_ERROR", label: "TorBox", timeoutMs: 6000 },
      );
      const cached = new Set(
        (Array.isArray(r.data) ? r.data.map((d) => d.hash) : Object.keys(r.data ?? {})).map((h) => h.toLowerCase()),
      );
      for (const h of chunk) out.set(h.toLowerCase(), cached.has(h.toLowerCase()));
    }
    return out;
  },
  async resolve(token, t) {
    const fd = new FormData();
    fd.set("magnet", t.magnet);
    fd.set("add_only_if_cached", "true");
    let created: TbEnvelope<{ torrent_id: number } | null>;
    try {
      const res = await fetch(`${TB}/torrents/createtorrent`, { method: "POST", headers: auth(token), body: fd, signal: AbortSignal.timeout(10_000) });
      created = (await res.json()) as TbEnvelope<{ torrent_id: number } | null>;
    } catch {
      throw new AppError("DEBRID_ERROR", "TorBox: unreachable");
    }
    if (!created.success || !created.data?.torrent_id) throw notCached("TorBox");
    const id = created.data.torrent_id;
    const list = await fetchJson<TbEnvelope<{ download_finished: boolean; files: { id: number; name: string; size: number }[] }>>(
      `${TB}/torrents/mylist?id=${id}&bypass_cache=true`,
      { headers: auth(token), errorCode: "DEBRID_ERROR", label: "TorBox" },
    );
    const files = (list.data.files ?? []).map((f) => ({ ref: f.id, path: f.name, size: f.size }));
    const file = pickFile(files, t, files);
    if (!file) throw new AppError("DEBRID_ERROR", "TorBox: no playable file");
    const dl = await fetchJson<TbEnvelope<string>>(
      `${TB}/torrents/requestdl?token=${encodeURIComponent(token)}&torrent_id=${id}&file_id=${file.ref}`,
      { errorCode: "DEBRID_ERROR", label: "TorBox" },
    );
    if (!dl.success || !dl.data) throw new AppError("DEBRID_ERROR", `TorBox: ${dl.detail ?? "no link"}`);
    return { url: dl.data, filename: file.path.split("/").pop() ?? null, sizeBytes: file.size };
  },
};

/* ═══════════════ AllDebrid ═══════════════ */
const AD = "https://api.alldebrid.com";
const AGENT = "wstreamer";

interface AdEnvelope<T> {
  status: "success" | "error";
  data?: T;
  error?: { code: string; message: string };
}
interface AdNode {
  n: string;
  s?: number;
  l?: string;
  e?: AdNode[];
}

function flatten(nodes: AdNode[], prefix = ""): { ref: string; path: string; size: number }[] {
  return nodes.flatMap((n) => (n.e ? flatten(n.e, `${prefix}${n.n}/`) : n.l ? [{ ref: n.l, path: prefix + n.n, size: n.s ?? 0 }] : []));
}

export const allDebrid: DebridAdapter = {
  provider: "ALLDEBRID",
  async checkCached() {
    return new Map();
  },
  async resolve(token, t) {
    const o = { headers: auth(token), errorCode: "DEBRID_ERROR" as const, label: "AllDebrid", timeoutMs: 10_000 };
    const up = await fetchJson<AdEnvelope<{ magnets: { id: number; ready: boolean; error?: { message: string } }[] }>>(
      `${AD}/v4/magnet/upload?agent=${AGENT}`,
      { ...o, method: "POST", form: { "magnets[]": t.magnet } },
    );
    const m = up.data?.magnets[0];
    if (up.status !== "success" || !m || m.error) throw new AppError("DEBRID_ERROR", `AllDebrid: ${m?.error?.message ?? up.error?.message ?? "upload failed"}`);
    if (!m.ready) {
      fetchJson(`${AD}/v4/magnet/delete?agent=${AGENT}`, { ...o, method: "POST", form: { id: String(m.id) } }).catch(() => undefined);
      throw notCached("AllDebrid");
    }
    const filesRes = await fetchJson<AdEnvelope<{ magnets: { files: AdNode[] }[] }>>(`${AD}/v4/magnet/files?agent=${AGENT}`, {
      ...o,
      method: "POST",
      form: { "id[]": String(m.id) },
    });
    const files = flatten(filesRes.data?.magnets[0]?.files ?? []);
    const file = pickFile(files, t, files);
    if (!file) throw new AppError("DEBRID_ERROR", "AllDebrid: no playable file");
    const unlock = await fetchJson<AdEnvelope<{ link: string; filename: string; filesize: number }>>(`${AD}/v4/link/unlock?agent=${AGENT}`, {
      ...o,
      method: "POST",
      form: { link: String(file.ref) },
    });
    if (unlock.status !== "success" || !unlock.data) throw new AppError("DEBRID_ERROR", `AllDebrid: ${unlock.error?.message ?? "unlock failed"}`);
    return { url: unlock.data.link, filename: unlock.data.filename, sizeBytes: unlock.data.filesize };
  },
};

export const ADAPTERS: Record<DebridProvider, DebridAdapter> = {
  REAL_DEBRID: realDebrid,
  TORBOX: torBox,
  ALLDEBRID: allDebrid,
};

export type { DebridTarget };
