const megabyte = 1024 * 1024;

const defaults = {
  packageMb: 100,
  fileMb: 20,
  expandedMb: 200,
} as const;

function configuredMegabytes(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getSkillUploadLimits() {
  const packageMb = configuredMegabytes('SKILL_UPLOAD_PACKAGE_MB', defaults.packageMb);
  const fileMb = configuredMegabytes('SKILL_UPLOAD_FILE_MB', defaults.fileMb);
  const expandedMb = configuredMegabytes('SKILL_UPLOAD_EXPANDED_MB', defaults.expandedMb);
  return {
    packageBytes: Math.floor(packageMb * megabyte),
    fileBytes: Math.floor(fileMb * megabyte),
    expandedBytes: Math.floor(expandedMb * megabyte),
    packageMb,
    fileMb,
    expandedMb,
  };
}

export function formatSkillUploadLimit(megabytes: number) {
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}
