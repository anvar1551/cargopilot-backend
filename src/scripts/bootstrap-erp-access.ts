// Import-safe denial, including compiled deployment without extra script assets.
if (require.main === module) {
  console.error("Legacy bootstrap disabled. Controlled signed-permit onboarding requires approved operator registration and concrete intent; no provisioning was performed.");
  process.exitCode = 1;
}
export {};
