export const PI_CLOUD_CUBE_TEMPLATE_IMAGE_PREFIX =
  "pi-cloud-cube-template-registry.cube-system.svc.cluster.local:5000/pi-cloud/cubesandbox-tool@";

const terminalStatuses = new Set(["FAILED", "ERROR", "CANCELLED"]);

export function parseCubeTemplateRetention(value) {
  const retention = Number(value ?? 3);
  if (!Number.isSafeInteger(retention) || retention < 2 || retention > 10) {
    throw new Error("Cube template retention must be an integer from 2 through 10");
  }
  return retention;
}

function agentDockTemplate(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    /^tpl-[a-z0-9]{24}$/.test(value.template_id ?? "") &&
    typeof value.image_info === "string" &&
    value.image_info.startsWith(PI_CLOUD_CUBE_TEMPLATE_IMAGE_PREFIX)
  );
}

function newestFirst(left, right) {
  const leftTime = Date.parse(left.created_at ?? "");
  const rightTime = Date.parse(right.created_at ?? "");
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : 0;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : 0;
  return normalizedRight - normalizedLeft || left.template_id.localeCompare(right.template_id);
}

export function selectCubeTemplatesForDeletion({
  inventory,
  protectedTemplateIds = [],
  retention,
}) {
  if (!Array.isArray(inventory)) {
    throw new Error("Cube template inventory must be an array");
  }
  const limit = parseCubeTemplateRetention(retention);
  const owned = inventory.filter(agentDockTemplate);
  const protectedIds = new Set(
    protectedTemplateIds.filter((value) => /^tpl-[a-z0-9]{24}$/.test(value ?? "")),
  );
  const keep = new Set(protectedIds);
  for (const template of owned.filter((value) => value.status === "READY").sort(newestFirst)) {
    if (keep.size >= limit) break;
    keep.add(template.template_id);
  }

  return owned
    .filter(
      (template) =>
        !keep.has(template.template_id) &&
        (template.status === "READY" || terminalStatuses.has(template.status)),
    )
    .sort((left, right) => -newestFirst(left, right));
}
