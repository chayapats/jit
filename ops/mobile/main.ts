import { readFileSync } from "node:fs";
import { buildMobileArtifact, mobileBuildSelection } from "./build";
import { verifyMobileArtifact } from "./artifact";

/** Local build/verify CLI only. No install, signing, credential, runtime grant or deployment command. */
export async function mobilePackageCommand(args: string[]): Promise<unknown> {
  if (args.length !== 2 || !args[1] || args[1].startsWith("-") || !["build", "verify"].includes(args[0]!)) throw Error("mobile_arguments_invalid");
  const manifest = args[0] === "build" ? await buildMobileArtifact(mobileBuildSelection(JSON.parse(readFileSync(args[1], "utf8")))) : verifyMobileArtifact(args[1]);
  return { contract: manifest.contract, id: manifest.id, platform: manifest.platform, source: manifest.source.commit, acceptance: manifest.acceptance, files: manifest.files.length };
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await mobilePackageCommand(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error && /^mobile_[a-z_]+$/.test(error.message) ? error.message : "mobile_package_failed"); process.exitCode = 1; }
}
