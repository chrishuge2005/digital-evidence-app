import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const network = await ethers.provider.getNetwork();
  const deploymentsDir = path.join(process.cwd(), "deployments");
  const artifactPath = path.join(deploymentsDir, `${network.name}.json`);

  if (!fs.existsSync(artifactPath)) {
    throw new Error(`No deployment artifact found for network ${network.name}`);
  }

  const deployment = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  console.log(`Verifying deployment at contract address: ${deployment.contractAddress}`);

  const EvidenceAnchor = await ethers.getContractFactory("EvidenceAnchor");
  const evidenceAnchor = EvidenceAnchor.attach(deployment.contractAddress);

  // 1. Verify Role Configuration
  const ANCHOR_WRITER_ROLE = ethers.keccak256(ethers.toUtf8String("ANCHOR_WRITER_ROLE"));
  const isWriter = await evidenceAnchor.hasRole(ANCHOR_WRITER_ROLE, deployment.anchorWriterAddress);
  console.log(`Is anchor writer configured correctly? ${isWriter}`);
  if (!isWriter) throw new Error("Anchor writer role verification failed!");

  console.log("Deployment validation checks passed successfully!");
}

main().catch((error) => {
  console.error("Verification failed:", error);
  process.exitCode = 1;
});