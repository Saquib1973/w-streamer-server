import { Router } from "express";
import { PutVaultSecretBody, VaultProvider, type ApiResponses } from "../../contracts/api.js";
import { prisma } from "../../db/prisma.js";
import { toVaultEntryDto } from "../../lib/dto.js";
import { AppError } from "../../lib/errors.js";
import { authenticate, requireAdmin } from "../../middleware/auth.js";
import { param, parseBody, uuidParam } from "../../middleware/validate.js";
import * as svc from "./service.js";

export const vaultRouter = Router();
vaultRouter.use(authenticate, requireAdmin);

vaultRouter.get("/", async (req, res) => {
  const rows = await prisma.vaultSecret.findMany({ where: { userId: req.auth!.userId }, orderBy: [{ provider: "asc" }, { label: "asc" }] });
  const out: ApiResponses["GET /vault"] = { entries: rows.map(toVaultEntryDto), providers: VaultProvider.options };
  res.json(out);
});

vaultRouter.put("/:provider", async (req, res) => {
  const p = VaultProvider.safeParse(param(req, "provider").toUpperCase());
  if (!p.success) throw new AppError("VALIDATION_FAILED", `Unknown provider. Use one of: ${VaultProvider.options.join(", ")}`);
  const body = parseBody(PutVaultSecretBody, req);
  const { entry, test } = await svc.putSecret(req.auth!.userId, p.data, body);
  const out: ApiResponses["PUT /vault/:provider"] = { entry: toVaultEntryDto(entry), test };
  res.json(out);
});

vaultRouter.post("/:id/test", async (req, res) => {
  const out: ApiResponses["POST /vault/:id/test"] = await svc.testStored(req.auth!.userId, uuidParam(req, "id"));
  res.json(out);
});

vaultRouter.delete("/:id", async (req, res) => {
  await svc.deleteSecret(req.auth!.userId, uuidParam(req, "id"));
  const out: ApiResponses["DELETE /vault/:id"] = { ok: true };
  res.json(out);
});
