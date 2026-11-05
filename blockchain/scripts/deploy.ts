import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer, writerAccount] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log(`Deploying EvidenceAnchor to network: ${network.name} (Chain ID: ${network.chainId})`);
  console.log(`Deployer address: ${deployer.address}`);

  const adminAddress = deployer.address;
  const anchorWriterAddress = writerAccount.address;

  console.log(`Configuring Admin: ${adminAddress}`);
  console.log(`Configuring Anchor Writer: ${anchorWriterAddress}`);

  const EvidenceAnchor = await ethers.getContractFactory("EvidenceAnchor");
  const evidenceAnchor = await EvidenceAnchor.deploy(adminAddress, anchorWriterAddress);

  await evidenceAnchor.waitForDeployment();
  const contractAddress = await evidenceAnchor.getAddress();
  
  const deployTx = evidenceAnchor.deploymentTransaction();
  const txHash = deployTx ? deployTx.hash : "N/A";
  const blockNumber = deployTx ? deployTx.blockNumber : 1;

  console.log(`EvidenceAnchor deployed to: ${contractAddress}`);
  console.log(`Deployment Transaction Hash: ${txHash}`);

  // Save deployment artifact securely
  const deploymentData = {
    network: network.name,
    chainId: network.chainId.toString(),
    contractName: "EvidenceAnchor",
    contractAddress: contractAddress,
    deployerAddress: deployer.address,
    adminAddress: adminAddress,
    anchorWriterAddress: anchorWriterAddress,
    deploymentTransactionHash: txHash,
    deploymentBlockNumber: blockNumber || 1,
    deployedAt: new Date().toISOString()
  };

  const deploymentsDir = path.join(process.cwd(), "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const artifactPath = path.join(deploymentsDir, `${network.name}.json`);
    fs.writeFileSync(artifactPath, JSON.stringify(deploymentData, null, 2));
  console.log(`Deployment artifact saved to: ${artifactPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});