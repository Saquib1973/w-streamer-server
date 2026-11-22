import type { ParsedStreamInfo } from "./api.js";

const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|TiB|GiB|MiB|KiB)\b/i;
const SEED_RE = /(?:👤|seeders?[:\s]*|S:\s*)(\d{1,6})/i;
const UNIT: Record<string, number> = { kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

export function parseStreamText(text: string, sizeHint?: number): ParsedStreamInfo {
  const t = text.replace(/[._]/g, " ");

  const resolution: ParsedStreamInfo["resolution"] = /\b(2160p|4k|uhd)\b/i.test(t)
    ? "2160p"
    : /\b1440p\b/i.test(t)
      ? "1440p"
      : /\b1080p\b/i.test(t)
        ? "1080p"
        : /\b720p\b/i.test(t)
          ? "720p"
          : /\b(480p|576p|sd)\b/i.test(t)
            ? "480p"
            : "unknown";

  const hdr: ParsedStreamInfo["hdr"] = [];
  if (/\b(dv|dovi|dolby\s?vision)\b/i.test(t)) hdr.push("DV");
  if (/\bhdr10\+|hdr10plus\b/i.test(t)) hdr.push("HDR10+");
  else if (/\bhdr(10)?\b/i.test(t)) hdr.push("HDR10");
  if (/\bhlg\b/i.test(t)) hdr.push("HLG");

  const codec: ParsedStreamInfo["codec"] = /\b(hevc|x265|h\s?265)\b/i.test(t)
    ? "HEVC"
    : /\bav1\b/i.test(t)
      ? "AV1"
      : /\bvp9\b/i.test(t)
        ? "VP9"
        : /\b(avc|x264|h\s?264)\b/i.test(t)
          ? "AVC"
          : "unknown";

  const audio: string[] = [];
  for (const [re, name] of [
    [/\batmos\b/i, "Atmos"],
    [/\btrue\s?hd\b/i, "TrueHD"],
    [/\bdts[\s-]?hd(\s?ma)?\b/i, "DTS-HD MA"],
    [/\bdts[\s-]?x\b/i, "DTS:X"],
    [/\bdts\b/i, "DTS"],
    [/\b(ddp|dd\+|e-?ac-?3)\s?(5 1|7 1)?/i, "DDP"],
    [/\b(dd|ac-?3)\s?(5 1|2 0)\b/i, "DD"],
    [/\baac\b/i, "AAC"],
    [/\bopus\b/i, "Opus"],
  ] as const) {
    if (re.test(t) && !(name === "DTS" && audio.some((a) => a.startsWith("DTS")))) audio.push(name);
  }

  let sizeBytes: number | null = sizeHint ?? null;
  const sm = SIZE_RE.exec(text);
  if (sizeBytes == null && sm) sizeBytes = Math.round(parseFloat(sm[1]!.replace(",", ".")) * (UNIT[sm[2]!.toLowerCase()] ?? 1));

  const seedM = SEED_RE.exec(text);
  const seeders = seedM ? Number(seedM[1]) : null;

  const groupM = /-([A-Za-z0-9]{2,15})(?:\.(mkv|mp4|avi))?\s*$/m.exec(text.split("\n")[0] ?? "");
  const container: ParsedStreamInfo["container"] = /\.mkv\b|\bmkv\b/i.test(text)
    ? "mkv"
    : /\.mp4\b|\bmp4\b/i.test(text)
      ? "mp4"
      : /\.webm\b/i.test(text)
        ? "webm"
        : "unknown";

  return { resolution, hdr, codec, audio, sizeBytes, seeders, releaseGroup: groupM?.[1] ?? null, container };
}

const RES_SCORE: Record<ParsedStreamInfo["resolution"], number> = { "2160p": 50, "1440p": 40, "1080p": 35, "720p": 20, "480p": 8, unknown: 10 };

/** Higher is better. Debrid-cached results always win. */
export function scoreStream(info: ParsedStreamInfo, cached: boolean, isHttp: boolean): number {
  let s = RES_SCORE[info.resolution];
  if (cached) s += 1000;
  else if (isHttp) s += 500;
  if (info.hdr.length) s += 5;
  if (info.audio.includes("Atmos") || info.audio.includes("TrueHD")) s += 2;
  if (info.seeders != null) s += Math.min(30, Math.log2(info.seeders + 1) * 3);
  else if (!cached && !isHttp) s -= 5;
  return s;
}

/** Season/episode from file name: S01E02, 1x02, "Episode 2". */
export function parseEpisode(name: string): { season: number | null; episode: number | null } {
  const m = /S(\d{1,2})[ ._-]?E(\d{1,3})/i.exec(name) ?? /\b(\d{1,2})x(\d{2,3})\b/.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  const e = /\b(?:ep?|episode)[ ._-]?(\d{1,3})\b/i.exec(name);
  return { season: null, episode: e ? Number(e[1]) : null };
}

export const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|flv|mpg|mpeg)$/i;

export function mimeForFile(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    {
      mp4: "video/mp4",
      m4v: "video/mp4",
      mkv: "video/x-matroska",
      webm: "video/webm",
      avi: "video/x-msvideo",
      mov: "video/quicktime",
      ts: "video/mp2t",
      m2ts: "video/mp2t",
      wmv: "video/x-ms-wmv",
      flv: "video/x-flv",
      mpg: "video/mpeg",
      mpeg: "video/mpeg",
      srt: "application/x-subrip",
      vtt: "text/vtt",
    }[ext] ?? "application/octet-stream"
  );
}

/** MKV container or HEVC/DTS/TrueHD need VLC/MPV backend on most devices. */
export const needsNativePlayer = (info: Pick<ParsedStreamInfo, "container" | "codec" | "audio" | "hdr">, filename?: string | null) =>
  info.container === "mkv" ||
  /\.mkv$/i.test(filename ?? "") ||
  info.codec === "HEVC" ||
  info.hdr.includes("DV") ||
  info.audio.some((a) => a.startsWith("DTS") || a === "TrueHD");
