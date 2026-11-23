import type { Addon } from "@prisma/client";
import type { CatalogRowDto, MetaPreviewDto } from "../../contracts/api.js";
import { CatalogResponse, MetaResponse, type AddonManifest, type ManifestCatalog, type MetaDetail, type MetaPreview } from "../../contracts/stremio.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/errors.js";
import { isAllowed, type ParentalPolicy } from "../../lib/maturity.js";
import { callAddon, fanOut, supports, visibleAddons } from "../addons/service.js";
import { getRatings } from "../ratings/service.js";

export interface Viewer {
  ownerId: string;
  profileId: string;
  policy: ParentalPolicy;
}

const MAX_BOARD_ROWS = 14;
const ROW_SIZE = 20;

const catalogsOf = (a: Addon): ManifestCatalog[] => (a.manifest as unknown as AddonManifest).catalogs ?? [];

const requiredExtras = (c: ManifestCatalog) => [
  ...(c.extra?.filter((e) => e.isRequired).map((e) => e.name) ?? []),
  ...(c.extraRequired ?? []),
];
const supportsExtra = (c: ManifestCatalog, name: string) =>
  !!c.extra?.some((e) => e.name === name) || !!c.extraSupported?.includes(name);

/** Applies parental policy + annotates certification and library state. */
export async function filterAndAnnotate(v: Viewer, metas: MetaPreview[]): Promise<MetaPreviewDto[]> {
  const items = metas.filter((m) => m && m.id && m.name);
  const ratings = v.policy.restricted ? await getRatings(v.ownerId, items.map((m) => ({ id: m.id, type: m.type }))) : new Map();
  const visible = items.filter((m) => isAllowed(v.policy, ratings.get(m.id) ?? null));
  if (visible.length === 0) return [];
  const lib = await prisma.libraryItem.findMany({
    where: { profileId: v.profileId, metaId: { in: visible.map((m) => m.id) } },
    select: { metaId: true },
  });
  const inLib = new Set(lib.map((l) => l.metaId));
  return visible.map((m) => ({ ...m, certification: ratings.get(m.id) ?? null, inLibrary: inLib.has(m.id) }));
}

async function fetchRow(v: Viewer, a: Addon, c: ManifestCatalog, extra?: Record<string, string | number | undefined>) {
  const r = CatalogResponse.safeParse(await callAddon(a, "catalog", c.type, c.id, extra));
  if (!r.success) throw new AppError("ADDON_INVALID_MANIFEST", `${a.name} returned an invalid catalog`);
  const items = await filterAndAnnotate(v, r.data.metas);
  return { items, hasMore: r.data.metas.length >= ROW_SIZE - 5 };
}

const rowKey = (a: Addon, c: ManifestCatalog) => `${a.id}:${c.type}:${c.id}`;

export async function board(v: Viewer) {
  const addons = (await visibleAddons(v.ownerId, v.policy, v.profileId)).filter((a) => a.resources.includes("catalog"));
  const targets: { a: Addon; c: ManifestCatalog }[] = [];
  for (const a of addons)
    for (const c of catalogsOf(a)) if (requiredExtras(c).length === 0 && targets.length < MAX_BOARD_ROWS) targets.push({ a, c });

  const settled = await Promise.allSettled(targets.map(({ a, c }) => fetchRow(v, a, c)));
  const rows: CatalogRowDto[] = [];
  settled.forEach((s, i) => {
    if (s.status !== "fulfilled" || s.value.items.length === 0) return;
    const { a, c } = targets[i]!;
    rows.push({
      key: rowKey(a, c),
      addonId: a.id,
      addonName: a.name,
      type: c.type,
      catalogId: c.id,
      title: `${c.name ?? c.id} · ${c.type === "movie" ? "Movies" : c.type === "series" ? "Series" : c.type}`,
      items: s.value.items,
      hasMore: s.value.hasMore,
    });
  });
  const hero = (rows[0]?.items ?? []).filter((m) => m.background).slice(0, 6);
  return { hero, rows };
}

export async function discoverFilters(v: Viewer) {
  const addons = (await visibleAddons(v.ownerId, v.policy, v.profileId)).filter((a) => a.resources.includes("catalog"));
  return addons.flatMap((a) =>
    catalogsOf(a)
      .filter((c) => !requiredExtras(c).some((n) => n !== "genre"))
      .map((c) => ({
        addonId: a.id,
        type: c.type,
        catalogId: c.id,
        title: `${a.name} · ${c.name ?? c.id}`,
        genres: c.extra?.find((e) => e.name === "genre")?.options ?? [],
      })),
  );
}

export async function catalogPage(v: Viewer, addonId: string, type: string, catalogId: string, q: { skip?: number; genre?: string; search?: string }) {
  const addons = await visibleAddons(v.ownerId, v.policy, v.profileId);
  const a = addons.find((x) => x.id === addonId);
  const c = a && catalogsOf(a).find((x) => x.id === catalogId && x.type === type);
  if (!a || !c) throw new AppError("NOT_FOUND", "Catalog not found");
  return fetchRow(v, a, c, { skip: q.skip || undefined, genre: q.genre, search: q.search });
}

export async function search(v: Viewer, query: string, type?: string) {
  const addons = (await visibleAddons(v.ownerId, v.policy, v.profileId)).filter((a) => a.resources.includes("catalog"));
  const targets = addons.flatMap((a) => catalogsOf(a).filter((c) => supportsExtra(c, "search") && (!type || c.type === type)).map((c) => ({ a, c })));
  const settled = await Promise.allSettled(targets.map(({ a, c }) => fetchRow(v, a, c, { search: query })));
  const rows: CatalogRowDto[] = [];
  settled.forEach((s, i) => {
    if (s.status !== "fulfilled" || !s.value.items.length) return;
    const { a, c } = targets[i]!;
    rows.push({ key: rowKey(a, c), addonId: a.id, addonName: a.name, type: c.type, catalogId: c.id, title: `${a.name} · ${c.type}`, items: s.value.items, hasMore: false });
  });
  return { rows };
}

/** Meta from the first addon (in user order) that serves it. */
/** How "complete" a meta is: series by episode/season coverage, movies by detail fields. */
function metaScore(m: MetaDetail): number {
  const vids = m.videos ?? [];
  const seasons = new Set(vids.map((x) => x.season ?? 0)).size;
  const details = [m.description, m.background, m.poster, m.logo, m.releaseInfo, m.imdbRating, m.runtime].filter(Boolean).length + (m.genres?.length ? 1 : 0) + (m.cast?.length ? 1 : 0);
  return vids.length * 10 + seasons * 50 + details;
}

/** After the first addon answers, wait at most this long for better answers. */
const META_GRACE_MS = 1500;

/**
 * Asks every meta addon at once (not one after another, which made slow or dead
 * addons stall the page) and returns the most complete answer: after the first
 * success we wait a short grace period for the others, then pick the best.
 * Addon order breaks ties.
 */
export async function getMeta(v: Viewer, type: string, id: string): Promise<{ meta: MetaDetail; addon: Addon }> {
  const addons = (await visibleAddons(v.ownerId, v.policy, v.profileId)).filter((a) => supports(a, "meta", type, id));
  if (!addons.length) throw new AppError("NOT_FOUND", "No addon could provide details for this title");

  const results: ({ meta: MetaDetail; addon: Addon } | null)[] = new Array(addons.length).fill(null);
  await new Promise<void>((resolve) => {
    let pending = addons.length;
    let grace: NodeJS.Timeout | null = null;
    const finish = () => {
      if (grace) clearTimeout(grace);
      resolve();
    };
    addons.forEach((a, i) => {
      callAddon(a, "meta", type, id)
        .then((raw) => {
          const r = MetaResponse.safeParse(raw);
          if (r.success && r.data.meta) {
            results[i] = { meta: r.data.meta, addon: a };
            if (!grace) grace = setTimeout(finish, META_GRACE_MS);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (--pending === 0) finish();
        });
    });
  });

  let best: { meta: MetaDetail; addon: Addon } | null = null;
  for (const r of results) if (r && (!best || metaScore(r.meta) > metaScore(best.meta))) best = r;
  if (!best) throw new AppError("NOT_FOUND", "No addon could provide details for this title");
  return best;
}

export { fanOut };
