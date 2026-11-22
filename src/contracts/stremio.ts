/**
 * Stremio Addon Protocol — runtime-validated types.
 * Spec: https://github.com/Stremio/stremio-addon-sdk/tree/master/docs/api
 *
 * Schemas are intentionally lenient (`.passthrough()` / `.nullish()` fields — real addons send null) because
 * third-party addons vary wildly; we validate what we depend on and keep the rest.
 */
import { z } from "zod";

export const ContentType = z.enum(["movie", "series", "channel", "tv", "other"]);
export type ContentType = z.infer<typeof ContentType>;

/* ───────────── Manifest ───────────── */

export const ManifestExtra = z
  .object({
    name: z.string(),
    isRequired: z.boolean().nullish(),
    options: z.array(z.string()).nullish(),
    optionsLimit: z.number().int().nullish(),
  })
  .passthrough();

export const ManifestCatalog = z
  .object({
    type: z.string(),
    id: z.string(),
    name: z.string().nullish(),
    extra: z.array(ManifestExtra).nullish(),
    /** legacy */
    extraSupported: z.array(z.string()).nullish(),
    extraRequired: z.array(z.string()).nullish(),
  })
  .passthrough();
export type ManifestCatalog = z.infer<typeof ManifestCatalog>;

export const ManifestResource = z.union([
  z.string(),
  z
    .object({
      name: z.string(),
      types: z.array(z.string()).nullish(),
      idPrefixes: z.array(z.string()).nullish(),
    })
    .passthrough(),
]);
export type ManifestResource = z.infer<typeof ManifestResource>;

export const AddonManifest = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullish(),
    logo: z.string().nullish(),
    background: z.string().nullish(),
    types: z.array(z.string()),
    resources: z.array(ManifestResource).min(1),
    catalogs: z.array(ManifestCatalog).default([]),
    idPrefixes: z.array(z.string()).nullish(),
    addonCatalogs: z.array(ManifestCatalog).nullish(),
    behaviorHints: z
      .object({
        adult: z.boolean().nullish(),
        p2p: z.boolean().nullish(),
        configurable: z.boolean().nullish(),
        configurationRequired: z.boolean().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type AddonManifest = z.infer<typeof AddonManifest>;

/* ───────────── Meta ───────────── */

export const MetaVideo = z
  .object({
    id: z.string(),
    title: z.string().nullish(),
    name: z.string().nullish(),
    released: z.string().nullish(),
    thumbnail: z.string().nullish(),
    season: z.number().int().nullish(),
    episode: z.number().int().nullish(),
    overview: z.string().nullish(),
  })
  .passthrough();
export type MetaVideo = z.infer<typeof MetaVideo>;

export const MetaPreview = z
  .object({
    id: z.string(),
    type: z.string(),
    name: z.string(),
    poster: z.string().nullish(),
    posterShape: z.enum(["square", "poster", "landscape"]).nullish(),
    background: z.string().nullish(),
    logo: z.string().nullish(),
    description: z.string().nullish(),
    releaseInfo: z.string().nullish(),
    imdbRating: z.string().nullish(),
    genres: z.array(z.string()).nullish(),
  })
  .passthrough();
export type MetaPreview = z.infer<typeof MetaPreview>;

export const MetaDetail = MetaPreview.extend({
  videos: z.array(MetaVideo).nullish(),
  runtime: z.string().nullish(),
  cast: z.array(z.string()).nullish(),
  director: z.array(z.string()).nullish(),
  country: z.string().nullish(),
  trailers: z.array(z.object({ source: z.string(), type: z.string() }).passthrough()).nullish(),
  behaviorHints: z
    .object({ defaultVideoId: z.string().nullable().nullish(), hasScheduledVideos: z.boolean().nullish() })
    .passthrough()
    .nullish(),
});
export type MetaDetail = z.infer<typeof MetaDetail>;

/* ───────────── Stream ───────────── */

export const AddonStream = z
  .object({
    /** one of url | ytId | infoHash | externalUrl must be present */
    url: z.string().nullish(),
    ytId: z.string().nullish(),
    infoHash: z.string().nullish(),
    fileIdx: z.number().int().nullish(),
    externalUrl: z.string().nullish(),
    name: z.string().nullish(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    sources: z.array(z.string()).nullish(), // "tracker:udp://..." / "dht:<hash>"
    subtitles: z.array(z.object({ id: z.string().nullish(), url: z.string(), lang: z.string() }).passthrough()).nullish(),
    behaviorHints: z
      .object({
        notWebReady: z.boolean().nullish(),
        bingeGroup: z.string().nullish(),
        filename: z.string().nullish(),
        videoSize: z.number().nullish(),
        videoHash: z.string().nullish(),
        proxyHeaders: z
          .object({ request: z.record(z.string(), z.string()).nullish(), response: z.record(z.string(), z.string()).nullish() })
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough()
  .refine((s) => !!(s.url || s.ytId || s.infoHash || s.externalUrl), {
    message: "stream must have url, ytId, infoHash or externalUrl",
  });
export type AddonStream = z.infer<typeof AddonStream>;

/* ───────────── Subtitles ───────────── */

export const AddonSubtitle = z.object({ id: z.string().nullish(), url: z.string(), lang: z.string() }).passthrough();
export type AddonSubtitle = z.infer<typeof AddonSubtitle>;

/* ───────────── Resource response envelopes ───────────── */

export const CatalogResponse = z.object({ metas: z.array(MetaPreview) }).passthrough();
export const MetaResponse = z.object({ meta: MetaDetail }).passthrough();
export const StreamResponse = z.object({ streams: z.array(z.unknown()) }).passthrough(); // items validated individually
export const SubtitlesResponse = z.object({ subtitles: z.array(AddonSubtitle) }).passthrough();
